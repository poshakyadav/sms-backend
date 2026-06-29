// src/db/schemas/school/school-feed-posts.ts

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";
import { schoolClassSectionsSchema } from "./school-class-sections";

// ─────────────────────────────────────────────────────────────────────────────
// FEED CONTENT TYPE
//
// POST  → Rich text post (≤ 1000 chars) with an optional single image stored
//         on Cloudflare R2. The image is compressed to ≤ 50 KB on the
//         frontend before upload (Canvas API → WebP blob → R2 presigned PUT).
//
// VIDEO → A YouTube video link. Only the videoId is stored (extracted from
//         the URL on creation). The iframe embed is rendered on the frontend
//         as https://www.youtube.com/embed/{youtubeVideoId}?rel=0&modestbranding=1
//         Zero hosting cost — YouTube serves the video.
// ─────────────────────────────────────────────────────────────────────────────

export const FeedContentType = {
  POST: "POST",
  VIDEO: "VIDEO",
} as const;

export type FeedContentTypeValue =
  (typeof FeedContentType)[keyof typeof FeedContentType];

// ─────────────────────────────────────────────────────────────────────────────
// FEED TARGET AUDIENCE
//
// Controls exactly who sees each post in their feed. Mirrors the targeting
// model already used in school-notifications.ts.
//
// ALL_SCHOOL              → every active user (students + parents + staff)
// STUDENTS_ONLY           → all students across the school
// PARENTS_ONLY            → all parents/guardians across the school
// CLASS_SECTION           → everyone (students + their parents) in one class-section
// CLASS_SECTION_STUDENTS  → only students in one class-section
// CLASS_SECTION_PARENTS   → only parents of students in one class-section
//
// When any CLASS_SECTION* value is used, classSectionId MUST be non-null.
// This invariant is enforced in the Zod schema and the service layer.
// ─────────────────────────────────────────────────────────────────────────────

export const FeedTargetAudience = {
  ALL_SCHOOL: "ALL_SCHOOL",
  STUDENTS_ONLY: "STUDENTS_ONLY",
  PARENTS_ONLY: "PARENTS_ONLY",
  CLASS_SECTION: "CLASS_SECTION",
  CLASS_SECTION_STUDENTS: "CLASS_SECTION_STUDENTS",
  CLASS_SECTION_PARENTS: "CLASS_SECTION_PARENTS",
} as const;

export type FeedTargetAudienceValue =
  (typeof FeedTargetAudience)[keyof typeof FeedTargetAudience];

/** All target audience values as a readonly tuple for Zod z.enum() */
export const ALL_FEED_TARGET_AUDIENCES = [
  FeedTargetAudience.ALL_SCHOOL,
  FeedTargetAudience.STUDENTS_ONLY,
  FeedTargetAudience.PARENTS_ONLY,
  FeedTargetAudience.CLASS_SECTION,
  FeedTargetAudience.CLASS_SECTION_STUDENTS,
  FeedTargetAudience.CLASS_SECTION_PARENTS,
] as const;

/** Target audiences that require a classSectionId to be set */
export const CLASS_SCOPED_AUDIENCES: readonly FeedTargetAudienceValue[] = [
  FeedTargetAudience.CLASS_SECTION,
  FeedTargetAudience.CLASS_SECTION_STUDENTS,
  FeedTargetAudience.CLASS_SECTION_PARENTS,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// FEED POSTS TABLE
// ─────────────────────────────────────────────────────────────────────────────

export const schoolFeedPostsSchema = sqliteTable(
  "feed_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    // The school owner (or any user with feed.post.create permission) who
    // created this post. SET NULL on user deletion so the post is preserved
    // for historical record — the createdByName snapshot handles display.
    createdBy: integer("created_by").references(() => schoolUsersSchema.id, {
      onDelete: "set null",
    }),

    /**
     * Snapshot of the creator's name at creation time.
     * Because createdBy is SET NULL on user deletion, we keep the name here
     * so the frontend can still display "Posted by Principal Sharma" even if
     * the user account is later removed.
     */
    createdByName: text("created_by_name").notNull().default(""),

    // ── CONTENT TYPE ─────────────────────────────────────────────────────────
    contentType: text("content_type")
      .$type<FeedContentTypeValue>()
      .notNull()
      .default("POST"),

    // ── POST FIELDS (populated when contentType = "POST") ────────────────────

    /**
     * Main text body of the post.
     * Maximum 1000 characters — enforced by Zod on the backend before insert.
     * NULL for VIDEO type posts.
     */
    postText: text("post_text"),

    /**
     * Public CDN URL of the compressed image stored on Cloudflare R2.
     * Format: https://<bucket>.r2.dev/feed/posts/<schoolId>/<uuid>.webp
     * NULL if no image was attached to this post.
     * The image is compressed to ≤ 50 KB by the frontend before upload.
     */
    imageUrl: text("image_url"),

    /**
     * R2 object key (e.g. "feed/posts/1/abc123.webp").
     * Stored so the backend can call r2.delete(imageKey) when the post is
     * deleted or the image is replaced during an edit.
     * NULL if no image was attached.
     */
    imageKey: text("image_key"),

    // ── VIDEO FIELDS (populated when contentType = "VIDEO") ──────────────────

    /**
     * The original YouTube URL as pasted by the admin.
     * Stored for audit / display purposes.
     * e.g. "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
     * NULL for POST type.
     */
    youtubeUrl: text("youtube_url"),

    /**
     * Extracted 11-character YouTube video ID.
     * Parsed from youtubeUrl on creation (backend regex).
     * Used to render the iframe: https://www.youtube.com/embed/{youtubeVideoId}
     * Stored separately so no URL parsing is needed at render time.
     * NULL for POST type.
     */
    youtubeVideoId: text("youtube_video_id"),

    /**
     * Admin-provided title/caption for the video.
     * Displayed above the YouTube embed in the feed card.
     * NULL for POST type.
     */
    videoTitle: text("video_title"),

    /**
     * Optional description shown below the video embed.
     * NULL for POST type or when no description was provided.
     */
    videoDescription: text("video_description"),

    // ── TARGETING ─────────────────────────────────────────────────────────────

    /**
     * Controls which users see this post in their feed.
     * See FeedTargetAudience constants above for semantics.
     */
    targetAudience: text("target_audience")
      .$type<FeedTargetAudienceValue>()
      .notNull()
      .default("ALL_SCHOOL"),

    /**
     * Required when targetAudience is CLASS_SECTION, CLASS_SECTION_STUDENTS,
     * or CLASS_SECTION_PARENTS. NULL otherwise.
     *
     * ON DELETE SET NULL: if the class-section is deleted, the post becomes
     * "orphaned" — it will not appear in any student/parent feed until the
     * admin updates or deletes the post. The admin management view still shows
     * it (with a warning badge) so it can be fixed.
     */
    classSectionId: integer("class_section_id").references(
      () => schoolClassSectionsSchema.id,
      {
        onDelete: "set null",
      }
    ),

    // ── LIFECYCLE FLAGS ───────────────────────────────────────────────────────

    /**
     * Draft / published toggle.
     * FALSE = draft — only visible in the admin management view.
     * TRUE  = published — visible to targeted audience in their feed.
     * Defaults to TRUE so "create post → visible immediately" is the happy path.
     * Admin can uncheck "Publish now" to save as draft.
     */
    isPublished: integer("is_published", { mode: "boolean" })
      .default(true)
      .notNull(),

    /**
     * Pinned posts are sorted before all other posts in the feed regardless
     * of creation date. Useful for important announcements.
     * Only one post should be pinned at a time (enforced in the service layer
     * by unpinning the previous pinned post on PATCH /pin).
     */
    isPinned: integer("is_pinned", { mode: "boolean" })
      .default(false)
      .notNull(),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // ── INDEXES ───────────────────────────────────────────────────────────────

    /**
     * Primary feed query index: school + audience + published + newest-first.
     * Covers the most common query: "give me all published posts for school X
     * with targetAudience IN (...) ORDER BY is_pinned DESC, created_at DESC"
     */
    feedMainIdx: index("idx_feed_posts_main").on(
      table.schoolId,
      table.targetAudience,
      table.isPublished,
      table.createdAt
    ),

    /**
     * Class-section scoped query index.
     * Covers: "posts for school X targeting class-section Y"
     */
    feedClassSectionIdx: index("idx_feed_posts_class_section").on(
      table.schoolId,
      table.classSectionId,
      table.isPublished,
      table.createdAt
    ),

    /**
     * Admin management view index: all posts by a specific creator.
     */
    feedCreatorIdx: index("idx_feed_posts_creator").on(
      table.schoolId,
      table.createdBy,
      table.createdAt
    ),
  })
);

export type SchoolFeedPost = typeof schoolFeedPostsSchema.$inferSelect;
export type NewSchoolFeedPost = typeof schoolFeedPostsSchema.$inferInsert;
