// src/utils/school/avatar-storage.ts
//
// Small dedicated helper for the user-avatars R2 bucket. Deliberately
// separate from whatever helper backs the feed-images bucket (not shown in
// context) — if you already have a shared `r2-client.ts` utility with a
// generic putObject/deleteObject, prefer wiring this through that instead
// of duplicating the S3Client setup below. I'm writing it standalone here
// so this feature works without assuming the shape of code I haven't seen.
//
// npm install @aws-sdk/client-s3
//
// R2 is S3-compatible — Cloudflare's docs recommend the AWS SDK v3 pointed
// at the account-specific R2 S3 endpoint.

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { SchoolEnv } from "../../types/common-types";

function getR2Client(env: SchoolEnv["Bindings"]): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Uploads a compressed avatar image to the user-avatars R2 bucket.
 *
 * Key shape: avatars/<schoolId>/<userId>/<uuid>.webp
 * A fresh uuid per upload (rather than overwriting a fixed key) means the
 * OLD object is explicitly deleted by the caller after a successful new
 * upload — avoiding any window where a failed upload could leave the user
 * with zero avatar if we'd deleted-then-uploaded instead.
 */
export async function uploadUserAvatar(
  env: SchoolEnv["Bindings"],
  params: {
    schoolId: number;
    userId: number;
    bytes: ArrayBuffer | Uint8Array;
    contentType?: string; // defaults to "image/webp" — frontend compresses to WebP
  }
): Promise<{ url: string; key: string }> {
  const client = getR2Client(env);
  const key = `avatars/${params.schoolId}/${
    params.userId
  }/${crypto.randomUUID()}.webp`;

  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_AVATARS_BUCKET_NAME,
      Key: key,
      Body: params.bytes as any,
      ContentType: params.contentType || "image/webp",
      CacheControl: "public, max-age=31536000, immutable", // safe since the key is unique per upload
    })
  );

  const url = `${env.R2_AVATARS_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  return { url, key };
}

/**
 * Deletes a previously uploaded avatar object. Safe to call with an empty/
 * null key (no-op) — callers don't need to guard this themselves.
 */
export async function deleteUserAvatar(
  env: SchoolEnv["Bindings"],
  key: string | null | undefined
): Promise<void> {
  if (!key) return;
  try {
    const client = getR2Client(env);
    await client.send(
      new DeleteObjectCommand({
        Bucket: env.R2_AVATARS_BUCKET_NAME,
        Key: key,
      })
    );
  } catch (err) {
    // Non-fatal — an orphaned R2 object is a minor storage cost, not a
    // correctness issue. Never let a delete failure block the user-facing
    // operation (replace/remove) from completing.
    console.error("Failed to delete old avatar from R2 (non-fatal):", err);
  }
}
