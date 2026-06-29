// src/modules/super/auth/services.ts

import { eq } from "drizzle-orm";
import {
  superUsersSchema,
  superUserRolesSchema,
} from "../../../db/schemas/super";
import { hashPassword, comparePassword } from "../../../utils/hashing";
import {
  generateSuperAccessToken,
  generateSuperRefreshToken,
  validateSuperRefreshToken,
} from "../../../utils/super/tokens";
import { getSuperUserPermissionsFromDB } from "./permission-helpers";
import { seedSuperPermissionsAndRoles } from "../permissions/services";
import { SuperRoleEnum } from "../../../types/super-role";
import { superRolesSchema } from "../../../db/schemas/super/super-roles";
import { refreshTokensSchema } from "../../../db/schemas/super/refresh-tokens";
import { seedRazorpayDefaults } from "./razorpay-seeder";

// ── Token pair generator ──────────────────────────────────────────────────────

export async function generateSuperTokens(
  db: any,
  user: {
    id: number;
    name: string;
    permissions: string[];
    tokenVersion: number;
  },
  secret: string
) {
  const access_token = await generateSuperAccessToken(
    {
      id: user.id,
      name: user.name,
      permissions: user.permissions as any,
      tokenVersion: user.tokenVersion,
    },
    secret
  );
  const refresh_token = await generateSuperRefreshToken(db, user.id);
  return { access_token, refresh_token };
}

// ── Register ──────────────────────────────────────────────────────────────────

export async function registerSuperUser(
  db: any,
  data: { name: string; email: string; password: string; roleId?: number }
) {
  // Ensure permissions + roles are seeded before first user
  await seedSuperPermissionsAndRoles(db);

  // ── WHY WE CALL seedRazorpayDefaults HERE ─────────────────────────────────
  //
  // The seeder creates two rows in access_plans (MONTHLY ₹599 / YEARLY ₹8985)
  // and four starter WhatsApp bundles in message_bundles. Without these rows,
  // the payment routes would throw "Access plan not found" or "Bundle not found"
  // on the first real payment attempt.
  //
  // We call it inside registerSuperUser (which runs on first-ever setup) rather
  // than on every request boot because:
  //   1. It's idempotent — will no-op on subsequent calls if rows exist.
  //   2. Cloudflare Workers have no "boot" lifecycle hook — you can't reliably
  //      run one-time setup code in module-level scope across all worker instances.
  //   3. registerSuperUser already runs seedSuperPermissionsAndRoles, so this
  //      is the established pattern in your codebase for one-time DB setup.
  //
  // If you want belt-and-suspenders safety (e.g. if someone manually deletes
  // the rows), you can also call seedRazorpayDefaults at the top of the
  // /auth/setup route or in a dedicated /super/seed endpoint.
  // ──────────────────────────────────────────────────────────────────────────
  await seedRazorpayDefaults(db);

  const existing = await db
    .select({ id: superUsersSchema.id })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, data.email))
    .get();
  if (existing) throw new Error("Email already taken");

  const passwordHash = await hashPassword(data.password);

  return db.transaction(async (tx: any) => {
    const [newUser] = await tx
      .insert(superUsersSchema)
      .values({
        name: data.name,
        email: data.email,
        passwordHash,
        tokenVersion: 0,
      })
      .returning();

    // Resolve target role — default to SUPERUSER
    let roleId = data.roleId;
    if (!roleId) {
      const defaultRole = await tx
        .select({ id: superRolesSchema.id })
        .from(superRolesSchema)
        .where(eq(superRolesSchema.name, SuperRoleEnum.SUPERUSER))
        .get();
      if (!defaultRole)
        throw new Error("Default role not found. Run seeder first.");
      roleId = defaultRole.id;
    }

    await tx
      .insert(superUserRolesSchema)
      .values({ userId: newUser.id, roleId });

    return newUser;
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function loginSuperUser(db: any, email: string, password: string) {
  const user = await db
    .select()
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, email))
    .get();

  if (!user || !(await comparePassword(password, user.passwordHash))) {
    throw new Error("Invalid credentials");
  }
  if (!user.isActive) throw new Error("Account deactivated");

  return user;
}

// ── Refresh ───────────────────────────────────────────────────────────────────

export async function refreshSuperAccessToken(
  db: any,
  refreshToken: string,
  secret: string
) {
  const payload = await validateSuperRefreshToken(db, refreshToken);
  if (!payload) throw new Error("Invalid or expired refresh token");

  const user = await db
    .select()
    .from(superUsersSchema)
    .where(eq(superUsersSchema.id, payload.userId))
    .get();
  if (!user) throw new Error("User not found");
  if (!user.isActive) throw new Error("Account deactivated");

  const permissions = await getSuperUserPermissionsFromDB(db, user.id);
  return generateSuperTokens(
    db,
    {
      id: user.id,
      name: user.name,
      permissions: permissions as string[],
      tokenVersion: user.tokenVersion,
    },
    secret
  );
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logoutSuperUser(
  db: any,
  refreshToken: string,
  userId: number
) {
  const entry = await db
    .select()
    .from(refreshTokensSchema)
    .where(eq(refreshTokensSchema.token, refreshToken))
    .get();

  // Ownership check
  if (!entry || entry.userId !== userId) {
    throw new Error("Refresh token not found or already invalidated");
  }

  await db
    .delete(refreshTokensSchema)
    .where(eq(refreshTokensSchema.token, refreshToken));
}
