// src/db/schemas/school/school-feed-post-interactions.ts

import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";
import { schoolFeedPostsSchema } from "./school-feed-posts";

// ─────────────────────────────────────────────────────────────────────────────
// FEED REACTION TYPE
//
// Kept intentionally small — a school management app is not a social network.
// Only reactions that are appropriate and meaningful in a school context.
//
// LIKE     → Generic positive acknowledgement ("👍 Noted it")
// LOVE     → Enthusiastic appreciation ("❤️  Great news!")
// CLAP     → Appreciation for achievement/event announcements ("👏")
// INSIGHTFUL → For informational/educational posts ("💡")
//
// The frontend maps each value to an emoji + label.
// ─────────────────────────────────────────────────────────────────────────────

export const FeedReactionType = {
  LIKE: "LIKE",
  LOVE: "LOVE",
  CLAP: "CLAP",
  INSIGHTFUL: "INSIGHTFUL",
} as const;

export type FeedReactionTypeValue =
  (typeof FeedReactionType)[keyof typeof FeedReactionType];

/** All reaction values as a readonly tuple for Zod z.enum() */
export const ALL_FEED_REACTION_TYPES = [
  FeedReactionType.LIKE,
  FeedReactionType.LOVE,
  FeedReactionType.CLAP,
  FeedReactionType.INSIGHTFUL,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// FEED POST INTERACTIONS TABLE
//
// One row per (userId, postId) pair — a user can react to the same post only
// once at a time, but they CAN CHANGE their reaction type by UPSERTing.
//
// This is enforced by the composite primary key (userId, postId).
//
// DESIGN DECISION: We use a single table for all reaction types rather than
// separate like/love/clap tables. This keeps the query simple:
//   SELECT reaction_type, COUNT(*) FROM feed_post_interactions
//   WHERE post_id = ? GROUP BY reaction_type
//
// UPSERT behaviour (handled in service layer):
//   - First reaction → INSERT
//   - Change reaction → UPDATE reaction_type
//   - Remove reaction → DELETE row
// ─────────────────────────────────────────────────────────────────────────────

export const schoolFeedPostInteractionsSchema = sqliteTable(
  "feed_post_interactions",
  {
    // ── COMPOSITE PK: one reaction per user per post ──────────────────────────
    // Defined at table level below via primaryKey({ columns: [...] })

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    postId: integer("post_id")
      .references(() => schoolFeedPostsSchema.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The user who reacted (student, parent, or staff — anyone with feed.view
     * permission can react).
     * ON DELETE CASCADE: if the user is deleted, their reactions are removed.
     */
    userId: integer("user_id")
      .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The reaction the user chose.
     * Can be updated (UPSERT) — a user can switch from LIKE to LOVE.
     */
    reactionType: text("reaction_type")
      .$type<FeedReactionTypeValue>()
      .notNull()
      .default("LIKE"),

    /**
     * Timestamp of when the reaction was first created (not updated on change).
     * Used for "first N reactors" display if needed in the future.
     */
    reactedAt: text("reacted_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // ── COMPOSITE PRIMARY KEY ─────────────────────────────────────────────────
    // Prevents duplicate reactions from the same user on the same post.
    // UPSERT (ON CONFLICT DO UPDATE) uses this key.
    pk: primaryKey({ columns: [table.userId, table.postId] }),

    // ── INDEX: reaction counts per post ──────────────────────────────────────
    // Covers: SELECT reaction_type, COUNT(*) WHERE post_id = ? GROUP BY reaction_type
    postReactionsIdx: index("idx_feed_interactions_post").on(
      table.postId,
      table.reactionType
    ),

    // ── INDEX: "my reactions" lookup ─────────────────────────────────────────
    // Covers: SELECT * WHERE user_id = ? AND post_id IN (...)
    // Used to annotate feed posts with the caller's own reaction.
    userReactionsIdx: index("idx_feed_interactions_user").on(
      table.userId,
      table.postId
    ),
  })
);

export type SchoolFeedPostInteraction =
  typeof schoolFeedPostInteractionsSchema.$inferSelect;
export type NewSchoolFeedPostInteraction =
  typeof schoolFeedPostInteractionsSchema.$inferInsert;
