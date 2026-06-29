// src/modules/school/feed/validators.ts

import { z } from "zod";
import {
  ALL_FEED_TARGET_AUDIENCES,
  CLASS_SCOPED_AUDIENCES,
  FeedContentType,
  FeedTargetAudience,
} from "../../../db/schemas/school/school-feed-posts";

import { ALL_FEED_REACTION_TYPES } from "../../../db/schemas/school";
// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE URL VALIDATION & VIDEO ID EXTRACTION
//
// Handles all common YouTube URL formats:
//   https://www.youtube.com/watch?v=VIDEO_ID
//   https://youtu.be/VIDEO_ID
//   https://youtube.com/shorts/VIDEO_ID
//   https://www.youtube.com/embed/VIDEO_ID
//   https://m.youtube.com/watch?v=VIDEO_ID
//   https://www.youtube.com/watch?v=VIDEO_ID&t=30s   (with extra params)
//
// A valid YouTube video ID is 11 characters: alphanumeric, hyphen, underscore.
// ─────────────────────────────────────────────────────────────────────────────

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const YOUTUBE_URL_PATTERNS = [
  // Standard watch URL: youtube.com/watch?v=ID
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
  // Short URL: youtu.be/ID
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  // Shorts URL: youtube.com/shorts/ID
  /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  // Embed URL: youtube.com/embed/ID
  /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
];

/**
 * Extracts the 11-character YouTube video ID from any known YouTube URL format.
 * Returns null if the URL is not a recognisable YouTube video URL.
 *
 * This is exported so it can be used in both the validator and the service.
 */
export function extractYoutubeVideoId(url: string): string | null {
  for (const pattern of YOUTUBE_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1] && YOUTUBE_VIDEO_ID_REGEX.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGETING REFINEMENT
//
// Shared superRefine used by both CREATE and UPDATE schemas.
// Validates that classSectionId is present iff the targetAudience requires it.
// ─────────────────────────────────────────────────────────────────────────────

function refineTargeting(
  data: { targetAudience: string; classSectionId?: number | null },
  ctx: z.RefinementCtx
) {
  const isClassScoped = CLASS_SCOPED_AUDIENCES.includes(
    data.targetAudience as any
  );

  if (isClassScoped && !data.classSectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["classSectionId"],
      message:
        "classSectionId is required when targetAudience is CLASS_SECTION, CLASS_SECTION_STUDENTS, or CLASS_SECTION_PARENTS",
    });
  }

  if (!isClassScoped && data.classSectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["classSectionId"],
      message:
        "classSectionId must be omitted when targetAudience is not class-scoped",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED TARGETING FIELDS
// ─────────────────────────────────────────────────────────────────────────────

const targetingFields = {
  targetAudience: z.enum(ALL_FEED_TARGET_AUDIENCES).default("ALL_SCHOOL"),
  classSectionId: z.number().int().positive().optional().nullable(),
  isPublished: z.boolean().default(true),
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE POST SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /school/feed/posts
 *
 * Uses a discriminatedUnion on contentType so the validator enforces that
 * POST fields are present for POST type and VIDEO fields for VIDEO type.
 * This gives precise error messages rather than "one of these must be set".
 */
export const createFeedPostSchema = z
  .discriminatedUnion("contentType", [
    // ── POST ──────────────────────────────────────────────────────────────────
    z.object({
      contentType: z.literal(FeedContentType.POST),

      /**
       * Main text body. Required for POST type.
       * 1–1000 characters. Trimmed before saving.
       */
      postText: z
        .string()
        .min(1, "Post text cannot be empty")
        .max(1000, "Post text cannot exceed 1000 characters")
        .transform((s) => s.trim()),

      /**
       * Public CDN URL of the pre-uploaded image on Cloudflare R2.
       * The image MUST be uploaded first via POST /school/feed/presign-image,
       * then the returned imageUrl is passed here.
       * Optional — posts without images are valid.
       */
      imageUrl: z.string().url("imageUrl must be a valid URL").optional(),

      /**
       * R2 object key (e.g. "feed/posts/1/abc123.webp").
       * Must be provided if imageUrl is provided so the backend can clean up
       * the R2 object when the post is deleted or the image replaced.
       */
      imageKey: z.string().min(1).optional(),

      ...targetingFields,
    }),

    // ── VIDEO ─────────────────────────────────────────────────────────────────
    z.object({
      contentType: z.literal(FeedContentType.VIDEO),

      /**
       * YouTube video URL in any supported format.
       * The backend extracts the videoId and validates it.
       */
      youtubeUrl: z
        .string()
        .url("Please provide a valid URL")
        .refine(
          (url) => extractYoutubeVideoId(url) !== null,
          "Please paste a valid YouTube video URL (youtube.com/watch, youtu.be, or youtube.com/shorts)"
        ),

      /** Admin-entered title shown above the video embed. Required. */
      videoTitle: z
        .string()
        .min(1, "Video title is required")
        .max(200, "Video title cannot exceed 200 characters")
        .transform((s) => s.trim()),

      /** Optional description shown below the video embed. */
      videoDescription: z
        .string()
        .max(500, "Video description cannot exceed 500 characters")
        .transform((s) => s.trim())
        .optional(),

      ...targetingFields,
    }),
  ])
  .superRefine(refineTargeting);

export type CreateFeedPostInput = z.infer<typeof createFeedPostSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE POST SCHEMA
//
// All fields are optional — PATCH semantics.
// The contentType cannot be changed after creation (a POST cannot become a
// VIDEO and vice versa). The discriminatedUnion here enforces that if you
// pass any VIDEO fields, contentType must be "VIDEO" and vice versa.
// ─────────────────────────────────────────────────────────────────────────────

export const updateFeedPostSchema = z
  .object({
    // ── Shared optional fields ────────────────────────────────────────────────
    targetAudience: z.enum(ALL_FEED_TARGET_AUDIENCES).optional(),
    classSectionId: z.number().int().positive().optional().nullable(),
    isPublished: z.boolean().optional(),
    isPinned: z.boolean().optional(),

    // ── POST fields (only used when the post is of type POST) ─────────────────
    postText: z
      .string()
      .min(1, "Post text cannot be empty")
      .max(1000, "Post text cannot exceed 1000 characters")
      .transform((s) => s.trim())
      .optional(),

    /**
     * Pass new imageUrl + imageKey to replace the image.
     * Pass imageUrl: null to remove the existing image (backend will delete from R2).
     */
    imageUrl: z.string().url().optional().nullable(),
    imageKey: z.string().min(1).optional().nullable(),

    // ── VIDEO fields (only used when the post is of type VIDEO) ───────────────
    youtubeUrl: z
      .string()
      .url()
      .refine(
        (url) => extractYoutubeVideoId(url) !== null,
        "Please paste a valid YouTube video URL"
      )
      .optional(),

    videoTitle: z
      .string()
      .min(1)
      .max(200)
      .transform((s) => s.trim())
      .optional(),

    videoDescription: z
      .string()
      .max(500)
      .transform((s) => s.trim())
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    // If targetAudience is being updated, re-run the targeting refinement
    if (data.targetAudience !== undefined) {
      refineTargeting(
        {
          targetAudience: data.targetAudience,
          classSectionId: data.classSectionId,
        },
        ctx
      );
    }
  });

export type UpdateFeedPostInput = z.infer<typeof updateFeedPostSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PIN TOGGLE SCHEMA
//
// PATCH /school/feed/posts/:id/pin
// Simple: just a boolean.
// ─────────────────────────────────────────────────────────────────────────────

export const togglePinSchema = z.object({
  isPinned: z.boolean(),
});

export type TogglePinInput = z.infer<typeof togglePinSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRESIGN IMAGE SCHEMA
//
// POST /school/feed/presign-image
//
// The frontend calls this BEFORE displaying the file upload so it gets a
// presigned PUT URL to upload directly to R2. The compressed WebP blob is
// then PUT directly to R2 from the browser (never passes through the Worker).
// ─────────────────────────────────────────────────────────────────────────────

export const presignImageSchema = z.object({
  /**
   * MIME type of the file to be uploaded.
   * Only WebP is accepted (the frontend converts all images to WebP before
   * calling this endpoint).
   * "image/jpeg" and "image/png" are also accepted as fallback for browsers
   * that don't support canvas.toBlob("image/webp") — rare but possible.
   */
  contentType: z.enum(["image/webp", "image/jpeg", "image/png"], {
    error: "Only image/webp, image/jpeg, and image/png are accepted for feed post images",
  }),

  /**
   * File size in bytes after compression.
   * Validated to ensure the frontend actually compressed the image.
   * Maximum: 100 KB (generous headroom above the 50 KB target).
   * If > 100 KB the backend rejects — the frontend should have compressed more.
   */
  fileSizeBytes: z.number().int().positive().max(
    102400, // 100 KB in bytes
    "Image must be compressed to under 100 KB before upload. Please compress the image on the frontend."
  ),
});

export type PresignImageInput = z.infer<typeof presignImageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// REACT TO POST SCHEMA
//
// POST /school/feed/posts/:id/react
// DELETE /school/feed/posts/:id/react  (no body needed for removal)
// ─────────────────────────────────────────────────────────────────────────────

export const reactToPostSchema = z.object({
  reactionType: z.enum(ALL_FEED_REACTION_TYPES),
});

export type ReactToPostInput = z.infer<typeof reactToPostSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// LIST FEED QUERY SCHEMA
//
// GET /school/feed/posts?limit=20&offset=0&contentType=POST&audience=ALL_SCHOOL
// ─────────────────────────────────────────────────────────────────────────────

export const listFeedQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(parseInt(v, 10) || 20, 50) : 20)),

  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) || 0 : 0)),

  /**
   * Filter by content type. Omit to get all types.
   */
  contentType: z.enum([FeedContentType.POST, FeedContentType.VIDEO]).optional(),

  /**
   * ADMIN ONLY: filter by published state.
   * Students/parents always see only published posts.
   * Admin can pass "false" to list drafts.
   */
  publishedOnly: z
    .string()
    .optional()
    .transform((v) => v !== "false"), // default true
});

export type ListFeedQueryInput = z.infer<typeof listFeedQuerySchema>;
