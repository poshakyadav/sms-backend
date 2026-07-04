// src/modules/school/feed/routes.ts

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import {
  createFeedPostSchema,
  listFeedQuerySchema,
  presignImageSchema,
  reactToPostSchema,
  togglePinSchema,
  updateFeedPostSchema,
} from "./validators";
import {
  createFeedPost,
  deleteFeedPost,
  generateFeedImagePresignedUrl,
  getFeedPost,
  listFeedPosts,
  removeFeedPostReaction,
  toggleFeedPostPin,
  updateFeedPost,
  upsertFeedPostReaction,
  type R2PresignEnv,
} from "./services";
import { schoolJwtMiddleware, schoolTokenValidationMiddleware } from "../../../middleware/school-auth";

const feedRouter = new Hono<SchoolEnv>();

feedRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD HELPERS
//
// Real permission slugs in use (per src/types/school-permissions.ts):
//
//   STAFF (category: "staff", Owner wildcard '*' covers all of these):
//     feed.post.create   — create posts/videos
//     feed.post.manage   — edit/delete/pin any post
//     feed.view          — view the feed
//     feed.react         — react to posts
//
//   STUDENT (category: "student", role STUDENT only):
//     feed.student.view
//     feed.student.react
//
//   PARENT (category: "parent", role STUDENT_PARENT only):
//     feed.parent.view
//     feed.parent.react
//
// View and react are SEPARATE permissions in all three categories. A caller
// who can view is not automatically assumed to be able to react — each
// route checks the slug that actually matches what it's doing.
// ─────────────────────────────────────────────────────────────────────────────

/** True if the caller can create/manage posts (owner wildcard or explicit grant). */
function canManageFeed(permissions: string[]): boolean {
  return (
    permissions.includes("*") ||
    permissions.includes("feed.post.create") ||
    permissions.includes("feed.post.manage")
  );
}

/**
 * True if the caller may view the feed at all.
 *
 * Checked independently per category — a staff member only needs "feed.view"
 * (NOT feed.post.create/manage) to view; manage rights are a superset that
 * also implies view access, which is why canManageFeed() is OR'd in last as
 * a safety net for any role that has manage rights but was never explicitly
 * given the plain "feed.view" slug (e.g. if a custom role is misconfigured).
 */
function canViewFeed(role: string, permissions: string[]): boolean {
  if (permissions.includes("*")) return true;

  if (role === SchoolRole.STUDENT) {
    return permissions.includes("feed.student.view");
  }

  if (role === SchoolRole.STUDENT_PARENT) {
    return permissions.includes("feed.parent.view");
  }

  // Staff / Owner / any other role category
  return permissions.includes("feed.view") || canManageFeed(permissions);
}

/**
 * True if the caller may react to (or remove a reaction from) a feed post.
 *
 * Deliberately separate from canViewFeed() — view and react are distinct
 * slugs in every category, so a role could in principle have one without
 * the other (e.g. a future "read-only" custom role). Reusing canViewFeed()
 * here would silently grant react rights to anyone who can merely view,
 * which doesn't match the permission model actually defined in
 * school-permissions.ts.
 */
function canReactToFeed(role: string, permissions: string[]): boolean {
  if (permissions.includes("*")) return true;

  if (role === SchoolRole.STUDENT) {
    return permissions.includes("feed.student.react");
  }

  if (role === SchoolRole.STUDENT_PARENT) {
    return permissions.includes("feed.parent.react");
  }

  // Staff / Owner / any other role category — manage rights imply react
  // rights too, same reasoning as canViewFeed()'s staff branch.
  return permissions.includes("feed.react") || canManageFeed(permissions);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/feed/posts — list feed (role-aware filtering happens inside
// listFeedPosts(); this route just authenticates + parses query params)
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.get(
  "/posts",
  zValidator("query", listFeedQuerySchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const role = user.role ?? "";
      if (!canViewFeed(role, user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const query = c.req.valid("query");
      const db = await getSchoolDB(c.env, schoolCode);

      // Parent's currently-selected child, same header pattern used
      // elsewhere in your codebase (school-auth, parent module, etc.)
      const activeChildIdHeader = c.req.header("X-Active-Child-Id");
      const activeChildId = activeChildIdHeader
        ? parseInt(activeChildIdHeader, 10)
        : undefined;

      const result = await listFeedPosts(
        db,
        user.id,
        role,
        activeChildId,
        query
      );

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("GET /school/feed/posts error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to fetch feed" },
        500
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/feed/posts/:id — single post
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.get("/posts/:id", async (c) => {
  try {
    const user = c.get("user");
    const schoolCode = c.get("schoolCode");
    if (!user || !schoolCode) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const role = user.role ?? "";
    if (!canViewFeed(role, user.permissions)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const postId = parseInt(c.req.param("id"), 10);
    if (isNaN(postId)) {
      return c.json({ success: false, error: "Invalid post ID" }, 400);
    }

    const db = await getSchoolDB(c.env, schoolCode);
    const post = await getFeedPost(db, postId, user.id);

    if (!post) {
      return c.json({ success: false, error: "Post not found" }, 404);
    }

    // Non-admin callers should never be able to fetch an unpublished post
    // directly by ID, even though listFeedPosts() already filters lists.
    if (!canManageFeed(user.permissions) && !post.isPublished) {
      return c.json({ success: false, error: "Post not found" }, 404);
    }

    return c.json({ success: true, post });
  } catch (error: any) {
    console.error("GET /school/feed/posts/:id error:", error);
    return c.json(
      { success: false, error: error.message || "Failed to fetch post" },
      500
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /school/feed/posts — create (SCHOOL_OWNER / feed.post.create only)
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.post(
  "/posts",
  zValidator("json", createFeedPostSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!canManageFeed(user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const data = c.req.valid("json");
      const db = await getSchoolDB(c.env, schoolCode);

      const created = await createFeedPost(db, data, user.id, user.name);

      return c.json({ success: true, post: created }, 201);
    } catch (error: any) {
      console.error("POST /school/feed/posts error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to create post" },
        500
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /school/feed/posts/:id — update (owner / feed.post.manage only)
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.patch(
  "/posts/:id",
  zValidator("json", updateFeedPostSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!canManageFeed(user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const postId = parseInt(c.req.param("id"), 10);
      if (isNaN(postId)) {
        return c.json({ success: false, error: "Invalid post ID" }, 400);
      }

      const data = c.req.valid("json");
      const db = await getSchoolDB(c.env, schoolCode);

      const updated = await updateFeedPost(
        db,
        postId,
        data,
        c.env as R2PresignEnv
      );

      if (!updated) {
        return c.json({ success: false, error: "Post not found" }, 404);
      }

      return c.json({ success: true, post: updated });
    } catch (error: any) {
      console.error("PATCH /school/feed/posts/:id error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to update post" },
        500
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /school/feed/posts/:id/pin — toggle pin (owner / feed.post.manage only)
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.patch(
  "/posts/:id/pin",
  zValidator("json", togglePinSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!canManageFeed(user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const postId = parseInt(c.req.param("id"), 10);
      if (isNaN(postId)) {
        return c.json({ success: false, error: "Invalid post ID" }, 400);
      }

      const { isPinned } = c.req.valid("json");
      const db = await getSchoolDB(c.env, schoolCode);

      const updated = await toggleFeedPostPin(db, postId, isPinned);

      if (!updated) {
        return c.json({ success: false, error: "Post not found" }, 404);
      }

      return c.json({ success: true, post: updated });
    } catch (error: any) {
      console.error("PATCH /school/feed/posts/:id/pin error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to toggle pin" },
        500
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /school/feed/posts/:id — hard delete (owner / feed.post.manage only)
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.delete("/posts/:id", async (c) => {
  try {
    const user = c.get("user");
    const schoolCode = c.get("schoolCode");
    if (!user || !schoolCode) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    if (!canManageFeed(user.permissions)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const postId = parseInt(c.req.param("id"), 10);
    if (isNaN(postId)) {
      return c.json({ success: false, error: "Invalid post ID" }, 400);
    }

    const db = await getSchoolDB(c.env, schoolCode);
    const deleted = await deleteFeedPost(db, postId, c.env as R2PresignEnv);

    if (!deleted) {
      return c.json({ success: false, error: "Post not found" }, 404);
    }

    return c.json({ success: true, message: "Post deleted" });
  } catch (error: any) {
    console.error("DELETE /school/feed/posts/:id error:", error);
    return c.json(
      { success: false, error: error.message || "Failed to delete post" },
      500
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /school/feed/presign-image — get R2 presigned PUT URL
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.post(
  "/presign-image",
  zValidator("json", presignImageSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      // Only SCHOOL_OWNER (or anyone with create rights) may request an
      // upload slot — students/parents never upload feed images.
      if (!canManageFeed(user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const { contentType } = c.req.valid("json");

      // schools.id is always 1 within a school's own isolated Turso DB.
      const schoolId = 1;

      const result = await generateFeedImagePresignedUrl(
        c.env as R2PresignEnv,
        schoolId,
        contentType
      );

      console.log("Generated presigned URL for feed image:", result);

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("POST /school/feed/presign-image error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to generate upload URL",
        },
        500
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /school/feed/posts/:id/react — add or change reaction
// DELETE /school/feed/posts/:id/react — remove reaction
//
// FIXED: now gated by canReactToFeed() (checks feed.react /
// feed.student.react / feed.parent.react) instead of canViewFeed(). Viewing
// and reacting are distinct permissions in the actual permission model —
// see school-permissions.ts STAFF_PERMISSION_SLUGS / STUDENT_PERMISSION_SLUGS
// / PARENT_PERMISSION_SLUGS, which list "*.view" and "*.react" as separate
// entries in every category.
// ─────────────────────────────────────────────────────────────────────────────

feedRouter.post(
  "/posts/:id/react",
  zValidator("json", reactToPostSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const schoolCode = c.get("schoolCode");
      if (!user || !schoolCode) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const role = user.role ?? "";
      if (!canReactToFeed(role, user.permissions)) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }

      const postId = parseInt(c.req.param("id"), 10);
      if (isNaN(postId)) {
        return c.json({ success: false, error: "Invalid post ID" }, 400);
      }

      const { reactionType } = c.req.valid("json");
      const db = await getSchoolDB(c.env, schoolCode);

      const schoolId = 1; // single-row schools table per school DB

      const result = await upsertFeedPostReaction(
        db,
        postId,
        user.id,
        reactionType,
        schoolId
      );

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("POST /school/feed/posts/:id/react error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to react" },
        500
      );
    }
  }
);

feedRouter.delete("/posts/:id/react", async (c) => {
  try {
    const user = c.get("user");
    const schoolCode = c.get("schoolCode");
    if (!user || !schoolCode) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const role = user.role ?? "";
    if (!canReactToFeed(role, user.permissions)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const postId = parseInt(c.req.param("id"), 10);
    if (isNaN(postId)) {
      return c.json({ success: false, error: "Invalid post ID" }, 400);
    }

    const db = await getSchoolDB(c.env, schoolCode);
    const result = await removeFeedPostReaction(db, postId, user.id);

    return c.json({ success: true, ...result });
  } catch (error: any) {
    console.error("DELETE /school/feed/posts/:id/react error:", error);
    return c.json(
      { success: false, error: error.message || "Failed to remove reaction" },
      500
    );
  }
});

export default feedRouter;
