// src/modules/school/feed/services.ts

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { AwsClient } from "aws4fetch";
import { schoolFeedPostsSchema } from "../../../db/schemas/school/school-feed-posts";
import { schoolFeedPostInteractionsSchema } from "../../../db/schemas/school/school-feed-post-interactions";
import { schoolStudentEnrollmentsSchema } from "../../../db/schemas/school/school-student-enrollments";
import { studentParentsSchema } from "../../../db/schemas/school/student-parents";
import { studentsSchema } from "../../../db/schemas/school/students";
import { schoolClassSectionsSchema } from "../../../db/schemas/school/school-class-sections";
import { schoolClassesSchema } from "../../../db/schemas/school/school-classes";
import { schoolSectionsSchema } from "../../../db/schemas/school/school-sections";
import {
  FeedTargetAudience,
  CLASS_SCOPED_AUDIENCES,
} from "../../../db/schemas/school/school-feed-posts";
import type {
  CreateFeedPostInput,
  UpdateFeedPostInput,
  ListFeedQueryInput,
} from "./validators";
import { extractYoutubeVideoId } from "./validators";
import { SchoolRole } from "../../../types/school-role";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fully enriched feed post as returned to the API caller.
 * Raw DB row + aggregated reactions + caller's own reaction + class label.
 */
export interface FeedPostWithMeta {
  id: number;
  schoolId: number;
  createdBy: number | null;
  createdByName: string;
  contentType: "POST" | "VIDEO";

  // POST fields
  postText: string | null;
  imageUrl: string | null;
  imageKey: string | null;

  // VIDEO fields
  youtubeUrl: string | null;
  youtubeVideoId: string | null;
  videoTitle: string | null;
  videoDescription: string | null;

  // Targeting
  targetAudience: string;
  classSectionId: number | null;

  // Lifecycle
  isPublished: boolean;
  isPinned: boolean;

  createdAt: string;
  updatedAt: string;

  // Aggregated reaction counts: { LIKE: 3, LOVE: 1, CLAP: 0, INSIGHTFUL: 2 }
  reactions: Record<string, number>;

  // The calling user's own reaction type ("LIKE" | "LOVE" | ...), null if none
  myReaction: string | null;

  // Human-readable class-section label for class-scoped posts, e.g. "Class 5 - A"
  // null for school-wide posts
  classSectionLabel: string | null;
}

export interface PaginatedFeedResult {
  posts: FeedPostWithMeta[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Environment bindings required by the R2 presign/delete helpers.
 * These are added to wrangler.toml as secrets.
 */
export interface R2PresignEnv {
  R2_ACCOUNT_ID: string; // Cloudflare account ID
  R2_ACCESS_KEY_ID: string; // R2 API token access key
  R2_SECRET_ACCESS_KEY: string; // R2 API token secret
  R2_FEED_BUCKET_NAME: string; // e.g. "school-feed-images"
  R2_FEED_PUBLIC_URL: string; // e.g. "https://feed.yourdomain.com" (no trailing slash)
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESIGN IMAGE UPLOAD URL
//
// Generates a presigned PUT URL for the Angular frontend to upload a
// compressed WebP image directly to Cloudflare R2 from the browser,
// bypassing the Worker entirely.
//
// Upload flow:
//   1. Frontend: compress image to ≤50 KB (Canvas API → WebP blob)
//   2. Frontend: POST /school/feed/presign-image → gets { presignedUrl, key, publicUrl }
//   3. Frontend: PUT compressed blob directly to presignedUrl (browser → R2)
//   4. Frontend: stores { imageUrl: publicUrl, imageKey: key }
//   5. Frontend: POST /school/feed/posts with { imageUrl, imageKey, ... }
//
// WHY aws4fetch AND NOT @aws-sdk/client-s3:
//   The AWS SDK v3 depends on Node.js APIs (DOMParser, etc.) that are
//   unavailable in Cloudflare Workers. aws4fetch uses only Web Crypto API
//   (SubtleCrypto) which IS available in Workers.
//
// IMPORTANT: Do NOT include Content-Type in signed headers when using
//   signQuery: true. aws4fetch with signQuery only signs "host". If you
//   sign Content-Type too, R2 rejects browser PUT requests with 403 because
//   the browser can modify headers after signing.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateFeedImagePresignedUrl(
  env: R2PresignEnv,
  schoolId: number,
  contentType: "image/webp" | "image/jpeg" | "image/png"
): Promise<{
  presignedUrl: string;
  key: string;
  publicUrl: string;
  expiresInSeconds: number;
}> {
  // Map MIME type to file extension
  const extMap: Record<string, string> = {
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/png": "png",
  };
  const ext = extMap[contentType] ?? "webp";

  // Key format: feed/posts/{schoolId}/{uuid}.{ext}
  // Namespaced per school so bulk cleanup (e.g. school offboarding) is trivial.
  const uuid = crypto.randomUUID();
  const key = `feed/posts/${schoolId}/${uuid}.${ext}`;

  const r2Endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const objectUrl = `${r2Endpoint}/${env.R2_FEED_BUCKET_NAME}/${key}`;

  // 15-minute window — plenty of time for upload, short enough to limit abuse
  const EXPIRES_IN_SECONDS = 900;

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });

  // signQuery: true embeds the AWS signature in the URL query string so the
  // browser can PUT with a plain fetch() call — no auth headers needed.
  const presignedRequest = await aws.sign(
    new Request(objectUrl, { method: "PUT" }),
    { aws: { signQuery: true } }
  );

  // Append the expiry parameter
  const presignedUrl = `${presignedRequest.url}&X-Amz-Expires=${EXPIRES_IN_SECONDS}`;

  // Permanent CDN URL for display (R2 bucket must have public access enabled)
  const publicUrl = `${env.R2_FEED_PUBLIC_URL}/${key}`;

  return { presignedUrl, key, publicUrl, expiresInSeconds: EXPIRES_IN_SECONDS };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE R2 OBJECT (fire-and-forget)
//
// Called when a post with an image is deleted or the image is replaced.
// Errors are logged but never surface to the caller — the DB operation is
// the source of truth and must not fail because of a storage cleanup issue.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteR2FeedImage(
  env: R2PresignEnv,
  imageKey: string
): Promise<void> {
  try {
    const r2Endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const objectUrl = `${r2Endpoint}/${env.R2_FEED_BUCKET_NAME}/${imageKey}`;

    const aws = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      region: "auto",
      service: "s3",
    });

    const signedRequest = await aws.sign(
      new Request(objectUrl, { method: "DELETE" })
    );

    const response = await fetch(signedRequest);

    if (!response.ok && response.status !== 404) {
      // 404 = already gone (idempotent) — not an error
      console.error(
        `[FeedService] R2 DELETE failed — key: "${imageKey}", status: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.error(`[FeedService] R2 DELETE threw — key: "${imageKey}":`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE CALLER'S CLASS-SECTION
//
// For feed filtering: we need to know which class-section the caller belongs
// to so we can include class-scoped posts targeted at their section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the classSectionId of the student's current active enrollment.
 * Returns null if no active enrollment found (student sees only school-wide posts).
 */
async function getStudentClassSectionId(
  db: any,
  userId: number
): Promise<number | null> {
  const row = await db
    .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, userId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    // Most recent enrollment wins (in case of re-enrollment edge cases)
    .orderBy(desc(schoolStudentEnrollmentsSchema.id))
    .get();

  return row?.classSectionId ?? null;
}

/**
 * Returns the classSectionId of the parent's active child's enrollment.
 *
 * @param activeChildId - from X-Active-Child-Id header (parent's currently
 *   selected child). Falls back to the primary-linked child if not provided.
 */
async function getParentChildClassSectionId(
  db: any,
  parentUserId: number,
  activeChildId: number | null | undefined
): Promise<number | null> {
  // Build the join condition:
  //   student_parents.parent_id = parentUserId
  //   AND (if activeChildId) student_parents.student_id = activeChildId
  const baseCondition = and(
    eq(studentParentsSchema.parentId, parentUserId),
    ...(activeChildId
      ? [eq(studentParentsSchema.studentId, activeChildId)]
      : [])
  );

  const row = await db
    .select({
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
    })
    .from(studentParentsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      and(
        eq(
          schoolStudentEnrollmentsSchema.studentId,
          studentParentsSchema.studentId
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .where(baseCondition)
    // If no specific child selected, prefer the primary-linked child
    .orderBy(desc(studentParentsSchema.isPrimary))
    .get();

  return row?.classSectionId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD FEED VISIBILITY WHERE CLAUSE
//
// The core filtering engine. Given the caller's role and their resolved
// classSectionId, returns a Drizzle condition for the posts they may see.
//
//   STUDENT         → ALL_SCHOOL | STUDENTS_ONLY
//                     + CLASS_SECTION | CLASS_SECTION_STUDENTS (if enrolled)
//
//   STUDENT_PARENT  → ALL_SCHOOL | PARENTS_ONLY
//                     + CLASS_SECTION | CLASS_SECTION_PARENTS (if child enrolled)
//
//   Staff / Owner   → no filter (admin sees everything)
// ─────────────────────────────────────────────────────────────────────────────

function buildFeedVisibilityClause(
  callerRole: string,
  callerClassSectionId: number | null
) {
  const isStudent = callerRole === SchoolRole.STUDENT;
  const isParent = callerRole === SchoolRole.STUDENT_PARENT;

  // Admin/staff: no audience filter — they see all posts
  if (!isStudent && !isParent) return null;

  if (isStudent) {
    const schoolWide = inArray(schoolFeedPostsSchema.targetAudience, [
      FeedTargetAudience.ALL_SCHOOL,
      FeedTargetAudience.STUDENTS_ONLY,
    ]);

    if (!callerClassSectionId) return schoolWide;

    return or(
      schoolWide,
      and(
        inArray(schoolFeedPostsSchema.targetAudience, [
          FeedTargetAudience.CLASS_SECTION,
          FeedTargetAudience.CLASS_SECTION_STUDENTS,
        ]),
        eq(schoolFeedPostsSchema.classSectionId, callerClassSectionId)
      )
    );
  }

  // isParent
  const schoolWide = inArray(schoolFeedPostsSchema.targetAudience, [
    FeedTargetAudience.ALL_SCHOOL,
    FeedTargetAudience.PARENTS_ONLY,
  ]);

  if (!callerClassSectionId) return schoolWide;

  return or(
    schoolWide,
    and(
      inArray(schoolFeedPostsSchema.targetAudience, [
        FeedTargetAudience.CLASS_SECTION,
        FeedTargetAudience.CLASS_SECTION_PARENTS,
      ]),
      eq(schoolFeedPostsSchema.classSectionId, callerClassSectionId)
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACH REACTION COUNTS + MY REACTION
//
// Called after the main feed query. Fetches all reaction rows for the given
// post IDs in a SINGLE query, then builds the aggregated counts and the
// caller's own reaction in memory (O(n)).
//
// Why not a JOIN? A LEFT JOIN of posts × reactions produces one row per
// (post, reaction) and inflates the result set. For 20 posts each with 50
// reactions that's 1000 rows vs 70 rows (20 posts + 50 reactions per post).
// A separate indexed query is both simpler and faster at typical feed sizes.
// ─────────────────────────────────────────────────────────────────────────────

async function attachReactions(
  db: any,
  posts: any[],
  callerUserId: number
): Promise<FeedPostWithMeta[]> {
  if (posts.length === 0) return [];

  const postIds = posts.map((p) => p.id as number);

  // Single query — idx_feed_interactions_post covers this
  const allReactions = await db
    .select({
      postId: schoolFeedPostInteractionsSchema.postId,
      userId: schoolFeedPostInteractionsSchema.userId,
      reactionType: schoolFeedPostInteractionsSchema.reactionType,
    })
    .from(schoolFeedPostInteractionsSchema)
    .where(inArray(schoolFeedPostInteractionsSchema.postId, postIds))
    .all();

  // Build lookup maps in a single pass — O(reactions) time
  const countMap = new Map<number, Record<string, number>>();
  const myReactionMap = new Map<number, string>();

  for (const r of allReactions) {
    // Aggregate counts
    if (!countMap.has(r.postId)) countMap.set(r.postId, {});
    const counts = countMap.get(r.postId)!;
    counts[r.reactionType] = (counts[r.reactionType] ?? 0) + 1;

    // Caller's own reaction
    if (r.userId === callerUserId) {
      myReactionMap.set(r.postId, r.reactionType);
    }
  }

  return posts.map((post) => ({
    ...post,
    reactions: countMap.get(post.id) ?? {},
    myReaction: myReactionMap.get(post.id) ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACH CLASS-SECTION LABELS
//
// For class-scoped posts, resolves "Class 5 - A" style labels from the
// class_sections → classes + sections join. One batch query for all unique
// classSectionIds in the current page.
// ─────────────────────────────────────────────────────────────────────────────

async function attachClassSectionLabels(db: any, posts: any[]): Promise<any[]> {
  // Collect unique class-section IDs that appear in class-scoped posts
  const ids = [
    ...new Set(
      posts
        .filter(
          (p) =>
            p.classSectionId != null &&
            CLASS_SCOPED_AUDIENCES.includes(p.targetAudience as any)
        )
        .map((p) => p.classSectionId as number)
    ),
  ];

  if (ids.length === 0) {
    return posts.map((p) => ({ ...p, classSectionLabel: null }));
  }

  const rows = await db
    .select({
      id: schoolClassSectionsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassesSchema.id, schoolClassSectionsSchema.classId)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolSectionsSchema.id, schoolClassSectionsSchema.sectionId)
    )
    .where(inArray(schoolClassSectionsSchema.id, ids))
    .all();

  const labelMap = new Map<number, string>(
    rows.map((r: any) => [r.id, `${r.className} - ${r.sectionName}`])
  );

  return posts.map((p) => ({
    ...p,
    classSectionLabel:
      p.classSectionId != null ? labelMap.get(p.classSectionId) ?? null : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST FEED POSTS (main entry point for GET /school/feed/posts)
// ─────────────────────────────────────────────────────────────────────────────

export async function listFeedPosts(
  db: any,
  callerUserId: number,
  callerRole: string,
  activeChildId: number | null | undefined,
  query: ListFeedQueryInput
): Promise<PaginatedFeedResult> {
  const { limit, offset, contentType, publishedOnly } = query;

  // ── 1. Resolve caller's class-section ─────────────────────────────────────
  let callerClassSectionId: number | null = null;

  if (callerRole === SchoolRole.STUDENT) {
    callerClassSectionId = await getStudentClassSectionId(db, callerUserId);
  } else if (callerRole === SchoolRole.STUDENT_PARENT) {
    callerClassSectionId = await getParentChildClassSectionId(
      db,
      callerUserId,
      activeChildId
    );
  }

  // ── 2. Build WHERE conditions ──────────────────────────────────────────────
  const isAdminOrStaff =
    callerRole !== SchoolRole.STUDENT &&
    callerRole !== SchoolRole.STUDENT_PARENT;

  const conditions: any[] = [];

  // Audience visibility (null for admin = no restriction)
  const visibilityClause = buildFeedVisibilityClause(
    callerRole,
    callerClassSectionId
  );
  if (visibilityClause) conditions.push(visibilityClause);

  // Published filter: students/parents always see only published posts
  // Admin can request drafts via ?publishedOnly=false
  if (!isAdminOrStaff || publishedOnly) {
    conditions.push(eq(schoolFeedPostsSchema.isPublished, true));
  }

  // Content type filter (optional)
  if (contentType) {
    conditions.push(eq(schoolFeedPostsSchema.contentType, contentType));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // ── 3. Count + page in parallel ───────────────────────────────────────────
  const [countRow, rawPosts] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schoolFeedPostsSchema)
      .where(whereClause)
      .get(),

    db
      .select()
      .from(schoolFeedPostsSchema)
      .where(whereClause)
      // Pinned posts always float to the top regardless of creation date.
      // SQLite: DESC on integer boolean — 1 (pinned) sorts before 0.
      .orderBy(
        desc(schoolFeedPostsSchema.isPinned),
        desc(schoolFeedPostsSchema.createdAt)
      )
      .limit(limit)
      .offset(offset)
      .all(),
  ]);

  const total = Number(countRow?.count ?? 0);

  // ── 4. Enrich posts ───────────────────────────────────────────────────────
  // Run label resolution and reaction aggregation in parallel since they
  // are independent queries.
  const [postsWithLabels] = await Promise.all([
    attachClassSectionLabels(db, rawPosts),
  ]);

  const postsWithReactions = await attachReactions(
    db,
    postsWithLabels,
    callerUserId
  );

  return {
    posts: postsWithReactions,
    total,
    limit,
    offset,
    hasMore: offset + rawPosts.length < total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE FEED POST
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeedPost(
  db: any,
  postId: number,
  callerUserId: number
): Promise<FeedPostWithMeta | null> {
  const post = await db
    .select()
    .from(schoolFeedPostsSchema)
    .where(eq(schoolFeedPostsSchema.id, postId))
    .get();

  if (!post) return null;

  // Enrich
  const [withLabel] = await attachClassSectionLabels(db, [post]);
  const [enriched] = await attachReactions(db, [withLabel], callerUserId);

  return enriched;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE FEED POST
// ─────────────────────────────────────────────────────────────────────────────

export async function createFeedPost(
  db: any,
  data: CreateFeedPostInput,
  createdBy: number,
  createdByName: string
): Promise<any> {
  const baseValues = {
    createdBy,
    createdByName,
    targetAudience: data.targetAudience,
    classSectionId: data.classSectionId ?? null,
    isPublished: data.isPublished,
    isPinned: false,
  };

  let insertValues: any;

  if (data.contentType === "POST") {
    insertValues = {
      ...baseValues,
      contentType: "POST",
      postText: data.postText,
      imageUrl: data.imageUrl ?? null,
      imageKey: data.imageKey ?? null,
      // VIDEO fields — always null for POST type
      youtubeUrl: null,
      youtubeVideoId: null,
      videoTitle: null,
      videoDescription: null,
    };
  } else {
    // VIDEO
    const youtubeVideoId = extractYoutubeVideoId(data.youtubeUrl);
    // Validator guarantees this is non-null, but be defensive
    if (!youtubeVideoId) {
      throw new Error("Invalid YouTube URL — could not extract video ID");
    }

    insertValues = {
      ...baseValues,
      contentType: "VIDEO",
      // POST fields — always null for VIDEO type
      postText: null,
      imageUrl: null,
      imageKey: null,
      youtubeUrl: data.youtubeUrl,
      youtubeVideoId,
      videoTitle: data.videoTitle,
      videoDescription: data.videoDescription ?? null,
    };
  }

  const [created] = await db
    .insert(schoolFeedPostsSchema)
    .values(insertValues)
    .returning();

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE FEED POST (PATCH semantics — only provided fields are updated)
// ─────────────────────────────────────────────────────────────────────────────

export async function updateFeedPost(
  db: any,
  postId: number,
  data: UpdateFeedPostInput,
  env: R2PresignEnv
): Promise<any | null> {
  // Read the existing post first:
  //   - Verify it exists (return null if not)
  //   - Get old imageKey in case image is being replaced/removed
  const existing = await db
    .select()
    .from(schoolFeedPostsSchema)
    .where(eq(schoolFeedPostsSchema.id, postId))
    .get();

  if (!existing) return null;

  // Build the update object — only include fields that were explicitly provided
  const updates: Record<string, any> = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  // ── Targeting fields ───────────────────────────────────────────────────────
  if (data.targetAudience !== undefined)
    updates.targetAudience = data.targetAudience;
  if (data.classSectionId !== undefined)
    updates.classSectionId = data.classSectionId;

  // ── Lifecycle flags ────────────────────────────────────────────────────────
  if (data.isPublished !== undefined) updates.isPublished = data.isPublished;
  if (data.isPinned !== undefined) updates.isPinned = data.isPinned;

  // ── POST text ──────────────────────────────────────────────────────────────
  if (data.postText !== undefined) updates.postText = data.postText;

  // ── Image replacement / removal ────────────────────────────────────────────
  // data.imageUrl = new URL  → replace image (delete old R2 object)
  // data.imageUrl = null     → remove image (delete old R2 object)
  // data.imageUrl = undefined → no change to image
  if (data.imageUrl !== undefined) {
    const oldKey = existing.imageKey as string | null;
    const imageChanged =
      data.imageUrl !== existing.imageUrl ||
      data.imageKey !== existing.imageKey;

    if (imageChanged && oldKey) {
      // Fire-and-forget: don't block the DB write on R2 cleanup
      deleteR2FeedImage(env, oldKey).catch((err) =>
        console.error(
          "[FeedService] updateFeedPost — old R2 image cleanup failed:",
          err
        )
      );
    }

    updates.imageUrl = data.imageUrl; // null = "remove image"
    updates.imageKey = data.imageKey ?? null;
  }

  // ── YouTube video update ───────────────────────────────────────────────────
  if (data.youtubeUrl !== undefined) {
    const youtubeVideoId = extractYoutubeVideoId(data.youtubeUrl);
    if (!youtubeVideoId)
      throw new Error("Invalid YouTube URL — could not extract video ID");
    updates.youtubeUrl = data.youtubeUrl;
    updates.youtubeVideoId = youtubeVideoId;
  }
  if (data.videoTitle !== undefined) updates.videoTitle = data.videoTitle;
  if (data.videoDescription !== undefined)
    updates.videoDescription = data.videoDescription;

  const [updated] = await db
    .update(schoolFeedPostsSchema)
    .set(updates)
    .where(eq(schoolFeedPostsSchema.id, postId))
    .returning();

  return updated ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE PIN
//
// Business rule: at most ONE post can be pinned at a time.
// When pinning post X, we unpin all other currently-pinned posts first.
// This is a service-layer invariant — the DB has no unique-on-pinned constraint
// because we don't want to ever block a write (that would surface as a 500).
// ─────────────────────────────────────────────────────────────────────────────

export async function toggleFeedPostPin(
  db: any,
  postId: number,
  isPinned: boolean
): Promise<any | null> {
  if (isPinned) {
    // Use a transaction to atomically unpin others and pin the target.
    // Without a transaction, there's a brief window where two posts are
    // pinned simultaneously — harmless but untidy.
    await db.transaction(async (tx: any) => {
      // Unpin all currently-pinned posts except the target
      await tx
        .update(schoolFeedPostsSchema)
        .set({ isPinned: false, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(schoolFeedPostsSchema.isPinned, true),
            sql`${schoolFeedPostsSchema.id} != ${postId}`
          )
        );

      // Pin the target post
      await tx
        .update(schoolFeedPostsSchema)
        .set({ isPinned: true, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(schoolFeedPostsSchema.id, postId));
    });
  } else {
    // Simple unpin — no transaction needed
    await db
      .update(schoolFeedPostsSchema)
      .set({ isPinned: false, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schoolFeedPostsSchema.id, postId));
  }

  // Return the updated post
  return (
    (await db
      .select()
      .from(schoolFeedPostsSchema)
      .where(eq(schoolFeedPostsSchema.id, postId))
      .get()) ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE FEED POST
//
// Hard delete. Interactions are removed by ON DELETE CASCADE on the FK.
// R2 image cleanup is fire-and-forget — a cleanup job could handle orphans
// later if needed.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteFeedPost(
  db: any,
  postId: number,
  env: R2PresignEnv
): Promise<boolean> {
  // Fetch the imageKey before deleting so we can clean up R2
  const existing = await db
    .select({
      id: schoolFeedPostsSchema.id,
      imageKey: schoolFeedPostsSchema.imageKey,
    })
    .from(schoolFeedPostsSchema)
    .where(eq(schoolFeedPostsSchema.id, postId))
    .get();

  if (!existing) return false;

  // Delete the DB record — interactions cascade automatically
  await db
    .delete(schoolFeedPostsSchema)
    .where(eq(schoolFeedPostsSchema.id, postId));

  // Fire-and-forget R2 cleanup
  if (existing.imageKey) {
    deleteR2FeedImage(env, existing.imageKey as string).catch((err) =>
      console.error("[FeedService] deleteFeedPost — R2 cleanup failed:", err)
    );
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET REACTION COUNTS FOR A POST
//
// Returns: { LIKE: 3, LOVE: 1, CLAP: 0, INSIGHTFUL: 2 }
// All four types are always present with a 0 floor (no undefined keys).
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeedPostReactions(
  db: any,
  postId: number
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      reactionType: schoolFeedPostInteractionsSchema.reactionType,
      count: sql<number>`COUNT(*)`,
    })
    .from(schoolFeedPostInteractionsSchema)
    .where(eq(schoolFeedPostInteractionsSchema.postId, postId))
    .groupBy(schoolFeedPostInteractionsSchema.reactionType)
    .all();

  // Start with all types at 0 so the frontend never sees undefined
  const result: Record<string, number> = {
    LIKE: 0,
    LOVE: 0,
    CLAP: 0,
    INSIGHTFUL: 0,
  };

  for (const row of rows) {
    result[row.reactionType] = Number(row.count);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT REACTION (add new or change existing)
//
// Business rule: one reaction per (userId, postId) — composite PK enforces it.
// Changing reaction type → UPDATE (not INSERT + DELETE) to preserve reactedAt.
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertFeedPostReaction(
  db: any,
  postId: number,
  userId: number,
  reactionType: string,
  schoolId: number
): Promise<{
  action: "created" | "updated";
  reactionType: string;
  reactions: Record<string, number>;
}> {
  // Check for an existing reaction from this user on this post
  const existing = await db
    .select({ reactionType: schoolFeedPostInteractionsSchema.reactionType })
    .from(schoolFeedPostInteractionsSchema)
    .where(
      and(
        eq(schoolFeedPostInteractionsSchema.postId, postId),
        eq(schoolFeedPostInteractionsSchema.userId, userId)
      )
    )
    .get();

  if (existing) {
    // User is changing their reaction type
    await db
      .update(schoolFeedPostInteractionsSchema)
      .set({ reactionType })
      .where(
        and(
          eq(schoolFeedPostInteractionsSchema.postId, postId),
          eq(schoolFeedPostInteractionsSchema.userId, userId)
        )
      );
  } else {
    // First reaction from this user on this post
    await db.insert(schoolFeedPostInteractionsSchema).values({
      schoolId,
      postId,
      userId,
      reactionType,
    });
  }

  // Return fresh aggregate counts
  const reactions = await getFeedPostReactions(db, postId);

  return {
    action: existing ? "updated" : "created",
    reactionType,
    reactions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE REACTION
// ─────────────────────────────────────────────────────────────────────────────

export async function removeFeedPostReaction(
  db: any,
  postId: number,
  userId: number
): Promise<{
  removed: boolean;
  reactions: Record<string, number>;
}> {
  const existing = await db
    .select({ userId: schoolFeedPostInteractionsSchema.userId })
    .from(schoolFeedPostInteractionsSchema)
    .where(
      and(
        eq(schoolFeedPostInteractionsSchema.postId, postId),
        eq(schoolFeedPostInteractionsSchema.userId, userId)
      )
    )
    .get();

  if (!existing) {
    // Idempotent: return current counts without error
    return {
      removed: false,
      reactions: await getFeedPostReactions(db, postId),
    };
  }

  await db
    .delete(schoolFeedPostInteractionsSchema)
    .where(
      and(
        eq(schoolFeedPostInteractionsSchema.postId, postId),
        eq(schoolFeedPostInteractionsSchema.userId, userId)
      )
    );

  return {
    removed: true,
    reactions: await getFeedPostReactions(db, postId),
  };
}
