// src/utils/school/logo-storage.ts
//
// Dedicated helper for the school-logos R2 bucket. Mirrors avatar-storage.ts
// exactly — same S3Client setup, same "upload new, then delete old" ordering
// so a failed upload never leaves a school with zero logo.
//
// npm install @aws-sdk/client-s3

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
 * Uploads a compressed logo image to the school-logos R2 bucket.
 *
 * Key shape: logos/<schoolId>/<uuid>.webp
 * A fresh uuid per upload (rather than overwriting a fixed key) means the
 * OLD object is explicitly deleted by the caller AFTER the new upload
 * succeeds — avoiding any window where a failed upload could leave the
 * school with zero logo if we'd deleted-then-uploaded instead.
 */
export async function uploadSchoolLogo(
    env: SchoolEnv["Bindings"],
    params: {
        schoolId: number;
        bytes: ArrayBuffer | Uint8Array;
        contentType?: string; // defaults to "image/webp" — frontend compresses to WebP
    }
): Promise<{ url: string; key: string }> {
    const client = getR2Client(env);
    const key = `logos/${params.schoolId}/${crypto.randomUUID()}.webp`;

    await client.send(
        new PutObjectCommand({
            Bucket: env.R2_LOGOS_BUCKET_NAME,
            Key: key,
            Body: params.bytes as any,
            ContentType: params.contentType || "image/webp",
            CacheControl: "public, max-age=31536000, immutable", // safe — key is unique per upload
        })
    );

    const url = `${env.R2_LOGOS_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    return { url, key };
}

/**
 * Deletes a previously uploaded logo object. Safe to call with an empty/
 * null key (no-op) — callers don't need to guard this themselves.
 */
export async function deleteSchoolLogo(
    env: SchoolEnv["Bindings"],
    key: string | null | undefined
): Promise<void> {
    if (!key) return;
    try {
        const client = getR2Client(env);
        await client.send(
            new DeleteObjectCommand({
                Bucket: env.R2_LOGOS_BUCKET_NAME,
                Key: key,
            })
        );
    } catch (err) {
        // Non-fatal — an orphaned R2 object is a minor storage cost, not a
        // correctness issue. Never let a delete failure block the user-facing
        // operation (replace/remove) from completing.
        console.error("Failed to delete old logo from R2 (non-fatal):", err);
    }
}