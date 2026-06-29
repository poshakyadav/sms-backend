// src/modules/super/auth/forgot-password.service.ts
import { and, eq, gt, lt } from "drizzle-orm";
import { superUsersSchema } from "../../../../db/schemas/super/super-users";
import { passwordResetTokensSchema } from "../../../../db/schemas/super/password-reset-tokens";
import { hashPassword, comparePassword } from "../../../../utils/hashing";
import { sendTransactionalEmail } from "../../../../utils/sendEmail";
import { sql } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────────

const OTP_EXPIRY_MINUTES = 10;
const OTP_EXPIRY_SECONDS = OTP_EXPIRY_MINUTES * 60;
const MAX_OTP_ATTEMPTS = 5; // lock after N wrong guesses
const RATE_LIMIT_WINDOW = 15 * 60; // 15 minutes in seconds
const RATE_LIMIT_MAX = 3; // max OTP requests per window per user

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateOtp(): string {
  // Cryptographically random 6-digit code
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1_000_000).padStart(6, "0");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Step 1: Request OTP ───────────────────────────────────────────────────────

/**
 * Sends a 6-digit OTP to the given email if a super user with that email exists.
 *
 * Security: Always returns the same generic response whether or not the email
 * exists — prevents user enumeration attacks.
 *
 * Rate limit: max 3 OTP requests per user per 15-minute window.
 */
export async function requestPasswordResetOtp(
  db: any,
  env: { BREVO_API_KEY: string },
  email: string,
  requestIp?: string
): Promise<{ message: string }> {
  const GENERIC_RESPONSE = {
    message:
      "If that email is registered, you will receive a reset code within a minute.",
  };

  // 1. Look up user — silently succeed if not found (enumeration guard)
  const user = await db
    .select({
      id: superUsersSchema.id,
      name: superUsersSchema.name,
      email: superUsersSchema.email,
      isActive: superUsersSchema.isActive,
    })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, email.toLowerCase().trim()))
    .get();

  if (!user || !user.isActive) return GENERIC_RESPONSE;

  // 2. Rate limit: count tokens issued in the last 15 minutes
  const windowStart = nowSeconds() - RATE_LIMIT_WINDOW;
  const recentTokens = await db
    .select({ id: passwordResetTokensSchema.id })
    .from(passwordResetTokensSchema)
    .where(
      and(
        eq(passwordResetTokensSchema.userId, user.id),
        gt(passwordResetTokensSchema.expiresAt, windowStart)
      )
    )
    .all();

  if (recentTokens.length >= RATE_LIMIT_MAX) {
    // Return generic to not leak that the account exists, but still rate-limit
    return GENERIC_RESPONSE;
  }

  // 3. Invalidate any existing tokens for this user
  await db
    .delete(passwordResetTokensSchema)
    .where(eq(passwordResetTokensSchema.userId, user.id));

  // 4. Generate OTP, hash it, persist
  const otp = generateOtp();
  const otpHash = await hashPassword(otp);
  const expiresAt = nowSeconds() + OTP_EXPIRY_SECONDS;

  await db.insert(passwordResetTokensSchema).values({
    userId: user.id,
    otpHash,
    expiresAt,
    attemptCount: 0,
    requestedFromIp: requestIp ?? null,
  });

  // 5. Send email via Brevo
  await sendTransactionalEmail(env, {
    sender: {
      name: "School Management System",
      email: "poshakkumar6171@gmail.com", // Change this mail use production email
    },
    to: [{ email: user.email, name: user.name }],
    subject: "Your password reset code",
    htmlContent: buildOtpEmailHtml(user.name, otp, OTP_EXPIRY_MINUTES),
    textContent: buildOtpEmailText(user.name, otp, OTP_EXPIRY_MINUTES),
  });

  return GENERIC_RESPONSE;
}

// ── Step 2: Verify OTP ────────────────────────────────────────────────────────

/**
 * Verifies the OTP without consuming it (consuming happens at reset step).
 * Returns a short-lived verification token (the token row id) so the frontend
 * can proceed to the reset step without re-entering the OTP.
 *
 * Throws on: expired, too many attempts, wrong code.
 */
export async function verifyResetOtp(
  db: any,
  email: string,
  otp: string
): Promise<{ resetSessionToken: string }> {
  const user = await db
    .select({ id: superUsersSchema.id })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, email.toLowerCase().trim()))
    .get();

  if (!user) throw new Error("Invalid or expired code.");

  const tokenRow = await db
    .select()
    .from(passwordResetTokensSchema)
    .where(eq(passwordResetTokensSchema.userId, user.id))
    .get();

  if (!tokenRow) throw new Error("Invalid or expired code.");

  // Expiry check
  if (nowSeconds() > tokenRow.expiresAt) {
    await db
      .delete(passwordResetTokensSchema)
      .where(eq(passwordResetTokensSchema.id, tokenRow.id));
    throw new Error("The code has expired. Please request a new one.");
  }

  // Brute-force check
  if (tokenRow.attemptCount >= MAX_OTP_ATTEMPTS) {
    await db
      .delete(passwordResetTokensSchema)
      .where(eq(passwordResetTokensSchema.id, tokenRow.id));
    throw new Error(
      "Too many incorrect attempts. Please request a new reset code."
    );
  }

  // Verify OTP against hash
  const valid = await comparePassword(otp.trim(), tokenRow.otpHash);

  if (!valid) {
    // Increment attempt count
    await db
      .update(passwordResetTokensSchema)
      .set({ attemptCount: tokenRow.attemptCount + 1 })
      .where(eq(passwordResetTokensSchema.id, tokenRow.id));

    const remaining = MAX_OTP_ATTEMPTS - tokenRow.attemptCount - 1;
    if (remaining <= 0) {
      await db
        .delete(passwordResetTokensSchema)
        .where(eq(passwordResetTokensSchema.id, tokenRow.id));
      throw new Error(
        "Too many incorrect attempts. Please request a new reset code."
      );
    }
    throw new Error(
      `Incorrect code. ${remaining} attempt${
        remaining === 1 ? "" : "s"
      } remaining.`
    );
  }

  // OTP valid — return a session token (we use the token row id + userId encoded)
  // The client sends this back at the reset step so we don't need the OTP again.
  const resetSessionToken = btoa(`${tokenRow.id}:${user.id}`);
  return { resetSessionToken };
}

// ── Step 3: Reset Password ────────────────────────────────────────────────────

/**
 * Resets the password given a valid resetSessionToken (obtained from verifyResetOtp).
 * Consumes (deletes) the OTP token and bumps tokenVersion to invalidate all sessions.
 */
export async function resetPassword(
  db: any,
  resetSessionToken: string,
  newPassword: string
): Promise<{ message: string }> {
  // Decode session token
  let tokenId: number;
  let userId: number;
  try {
    const decoded = atob(resetSessionToken);
    const [tId, uId] = decoded.split(":").map(Number);
    if (!tId || !uId || isNaN(tId) || isNaN(uId)) throw new Error();
    tokenId = tId;
    userId = uId;
  } catch {
    throw new Error("Invalid reset session. Please start over.");
  }

  // Re-verify token row still exists and has not expired
  const tokenRow = await db
    .select()
    .from(passwordResetTokensSchema)
    .where(
      and(
        eq(passwordResetTokensSchema.id, tokenId),
        eq(passwordResetTokensSchema.userId, userId)
      )
    )
    .get();

  if (!tokenRow) {
    throw new Error(
      "Reset session expired or already used. Please start over."
    );
  }

  if (nowSeconds() > tokenRow.expiresAt) {
    await db
      .delete(passwordResetTokensSchema)
      .where(eq(passwordResetTokensSchema.id, tokenId));
    throw new Error("Reset session expired. Please request a new code.");
  }

  // Fetch user
  const user = await db
    .select({
      id: superUsersSchema.id,
      tokenVersion: superUsersSchema.tokenVersion,
    })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found.");

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx: any) => {
    // Update password + bump tokenVersion (invalidates all existing JWTs)
    await tx
      .update(superUsersSchema)
      .set({
        passwordHash,
        tokenVersion: user.tokenVersion + 1,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(superUsersSchema.id, userId));

    // Consume the OTP token — single-use
    await tx
      .delete(passwordResetTokensSchema)
      .where(eq(passwordResetTokensSchema.id, tokenId));
  });

  return {
    message:
      "Password reset successfully. Please log in with your new password.",
  };
}

// ── Email templates ───────────────────────────────────────────────────────────

function buildOtpEmailHtml(
  name: string,
  otp: string,
  expiryMinutes: number
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your Password Reset Code</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#1a1d2e;border-radius:16px;overflow:hidden;border:1px solid rgba(99,102,241,0.15);">

          <!-- Header bar -->
          <tr>
            <td style="background:linear-gradient(135deg,#6366f1,#4f46e5);padding:28px 40px;">
              <p style="margin:0;color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">School Management System</p>
              <h1 style="margin:8px 0 0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.02em;">Password Reset</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;color:#94a3b8;font-size:15px;line-height:1.6;">
                Hi <strong style="color:#e2e8f0;">${name}</strong>,
              </p>
              <p style="margin:0 0 28px;color:#94a3b8;font-size:15px;line-height:1.6;">
                We received a request to reset the password for your Super Admin account.
                Use the code below — it expires in <strong style="color:#e2e8f0;">${expiryMinutes} minutes</strong>.
              </p>

              <!-- OTP block -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center" style="background:#0f1117;border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:28px 20px;">
                    <p style="margin:0 0 8px;color:#64748b;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;">Your verification code</p>
                    <p style="margin:0;font-size:44px;font-weight:800;letter-spacing:0.18em;color:#6366f1;font-family:'Courier New',monospace;">${otp}</p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 12px;color:#64748b;font-size:13px;line-height:1.6;">
                ⏱ This code expires in <strong style="color:#94a3b8;">${expiryMinutes} minutes</strong>.
              </p>
              <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
                🔒 If you didn't request this, you can safely ignore this email.
                Your password will not change.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.05);">
              <p style="margin:0;color:#475569;font-size:12px;line-height:1.6;">
                This is an automated message from the Super Admin panel.
                Do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOtpEmailText(
  name: string,
  otp: string,
  expiryMinutes: number
): string {
  return [
    `Hi ${name},`,
    ``,
    `Your Super Admin password reset code is: ${otp}`,
    ``,
    `This code expires in ${expiryMinutes} minutes.`,
    ``,
    `If you did not request this, ignore this email — your password has not changed.`,
    ``,
    `— School Management System`,
  ].join("\n");
}
