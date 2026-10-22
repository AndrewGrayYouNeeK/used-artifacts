import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email/mailer";
import { generateToken, sha256Hex } from "@/lib/crypto";
import {
  PasswordSchema,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/auth/password";
import { writeAuditEvent } from "@/domains/audit/audit";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_MAX_PER_HOUR = 3;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IdentityDeps {
  db: Db;
  mailer: Mailer;
  appUrl: string;
  now?: () => Date;
}

export interface RequestContext {
  ipHash?: string | null;
  userAgent?: string | null;
}

export const EmailSchema = z
  .email({ error: "Enter a valid email address." })
  .trim()
  .toLowerCase()
  .max(254);

export const SignupSchema = z.object({
  email: EmailSchema,
  displayName: z
    .string()
    .trim()
    .min(2, { error: "Display name must be at least 2 characters." })
    .max(60, { error: "Display name must be at most 60 characters." }),
  password: PasswordSchema,
});

export type SignupInput = z.infer<typeof SignupSchema>;

const clock = (deps: IdentityDeps) => (deps.now ? deps.now() : new Date());

async function sendVerificationEmail(
  deps: IdentityDeps,
  user: { id: string; email: string },
) {
  const token = generateToken();
  await deps.db.emailVerificationToken.create({
    data: {
      userId: user.id,
      email: user.email,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(clock(deps).getTime() + EMAIL_VERIFICATION_TTL_MS),
    },
  });
  const link = `${deps.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await deps.mailer.send({
    to: user.email,
    subject: "Verify your Used Artifacts email",
    text: `Confirm your email address to finish setting up your account:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
  });
}

export type SignupResult = { ok: true } | { ok: false; reason: "EMAIL_TAKEN" };

export async function signup(
  deps: IdentityDeps,
  input: SignupInput,
  ctx: RequestContext = {},
): Promise<SignupResult> {
  const existing = await deps.db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    return { ok: false, reason: "EMAIL_TAKEN" };
  }
  const passwordHash = await hashPassword(input.password);
  const user = await deps.db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email: input.email, displayName: input.displayName, passwordHash },
    });
    await writeAuditEvent(tx, {
      actorUserId: created.id,
      actorType: "USER",
      action: "user.signup",
      subjectType: "User",
      subjectId: created.id,
      ipHash: ctx.ipHash,
    });
    return created;
  });
  await sendVerificationEmail(deps, user);
  return { ok: true };
}

export type VerifyEmailResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "INVALID_OR_EXPIRED" };

export async function verifyEmail(deps: IdentityDeps, token: string): Promise<VerifyEmailResult> {
  const now = clock(deps);
  return deps.db.$transaction(async (tx) => {
    const record = await tx.emailVerificationToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (
      !record ||
      record.usedAt ||
      record.expiresAt <= now ||
      record.email !== record.user.email
    ) {
      return { ok: false, reason: "INVALID_OR_EXPIRED" } as const;
    }
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      return { ok: false, reason: "INVALID_OR_EXPIRED" } as const;
    }
    await tx.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: record.user.emailVerifiedAt ?? now },
    });
    await writeAuditEvent(tx, {
      actorUserId: record.userId,
      actorType: "USER",
      action: "user.email_verified",
      subjectType: "User",
      subjectId: record.userId,
    });
    return { ok: true, userId: record.userId } as const;
  });
}

export type LoginResult =
  | { ok: true; userId: string; sessionToken: string; expiresAt: Date }
  | { ok: false; reason: "INVALID_CREDENTIALS" | "EMAIL_NOT_VERIFIED" | "ACCOUNT_DISABLED" };

export async function login(
  deps: IdentityDeps,
  input: { email: string; password: string },
  ctx: RequestContext = {},
): Promise<LoginResult> {
  const email = EmailSchema.safeParse(input.email);
  const user = email.success
    ? await deps.db.user.findUnique({ where: { email: email.data } })
    : null;

  if (!user) {
    await verifyAgainstDummy(input.password);
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  await deps.db.loginEvent.create({
    data: { userId: user.id, succeeded: passwordOk, ipHash: ctx.ipHash ?? null },
  });
  if (!passwordOk) {
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }
  if (user.status !== "ACTIVE") {
    return { ok: false, reason: "ACCOUNT_DISABLED" };
  }
  if (!user.emailVerifiedAt) {
    // The correct password was given, so re-sending the link leaks nothing.
    await sendVerificationEmail(deps, user);
    return { ok: false, reason: "EMAIL_NOT_VERIFIED" };
  }

  const sessionToken = generateToken();
  const expiresAt = new Date(clock(deps).getTime() + SESSION_TTL_MS);
  await deps.db.$transaction(async (tx) => {
    await tx.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(sessionToken),
        expiresAt,
        ipHash: ctx.ipHash ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: user.id,
      actorType: "USER",
      action: "user.login",
      subjectType: "User",
      subjectId: user.id,
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true, userId: user.id, sessionToken, expiresAt };
}

export async function logout(deps: Pick<IdentityDeps, "db">, sessionToken: string) {
  const session = await deps.db.session.findUnique({
    where: { tokenHash: sha256Hex(sessionToken) },
  });
  if (!session) return;
  await deps.db.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { id: session.id } });
    await writeAuditEvent(tx, {
      actorUserId: session.userId,
      actorType: "USER",
      action: "user.logout",
      subjectType: "User",
      subjectId: session.userId,
    });
  });
}

export type PasswordResetRequestOutcome = "SENT" | "SKIPPED" | "RATE_LIMITED";

/**
 * Emails a single-use reset link to the user's verified address. Public callers
 * must ignore the outcome so the form can't be used to probe which emails exist.
 * `requestedByUserId` is set when the owner triggers it from the GM dashboard;
 * the link still only goes to the user, who must complete the reset themselves.
 */
export async function requestPasswordReset(
  deps: IdentityDeps,
  input: { email: string; requestedByUserId?: string },
  ctx: RequestContext = {},
): Promise<PasswordResetRequestOutcome> {
  const email = EmailSchema.safeParse(input.email);
  if (!email.success) return "SKIPPED";
  const user = await deps.db.user.findUnique({ where: { email: email.data } });
  if (!user || !user.emailVerifiedAt || user.status === "BANNED") return "SKIPPED";

  const now = clock(deps);
  const recent = await deps.db.passwordResetToken.count({
    where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (recent >= PASSWORD_RESET_MAX_PER_HOUR) return "RATE_LIMITED";

  const token = generateToken();
  await deps.db.$transaction(async (tx) => {
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        requestedIp: ctx.ipHash ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.requestedByUserId ?? user.id,
      actorType: input.requestedByUserId ? "ADMIN" : "USER",
      action: input.requestedByUserId
        ? "admin.password_reset_email_sent"
        : "user.password_reset_requested",
      subjectType: "User",
      subjectId: user.id,
      ipHash: ctx.ipHash,
    });
  });

  const link = `${deps.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await deps.mailer.send({
    to: user.email,
    subject: "Reset your Used Artifacts password",
    text: `Someone asked to reset the password for this account. If it was you, choose a new password here:\n\n${link}\n\nThis link works once and expires in 30 minutes. If you didn't ask for this, ignore this email; your password won't change.`,
  });
  return "SENT";
}

export type ResetPasswordResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "INVALID_OR_EXPIRED" };

export async function resetPassword(
  deps: IdentityDeps,
  input: { token: string; newPassword: string },
  ctx: RequestContext = {},
): Promise<ResetPasswordResult> {
  const newPassword = PasswordSchema.parse(input.newPassword);
  const now = clock(deps);
  const record = await deps.db.passwordResetToken.findUnique({
    where: { tokenHash: sha256Hex(input.token) },
    include: { user: true },
  });
  if (
    !record ||
    record.usedAt ||
    record.expiresAt <= now ||
    !record.user.emailVerifiedAt ||
    record.user.status === "BANNED"
  ) {
    return { ok: false, reason: "INVALID_OR_EXPIRED" };
  }

  const passwordHash = await hashPassword(newPassword);
  const applied = await deps.db.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return false;
    await tx.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    const revoked = await tx.session.deleteMany({ where: { userId: record.userId } });
    await writeAuditEvent(tx, {
      actorUserId: record.userId,
      actorType: "USER",
      action: "user.password_reset_completed",
      subjectType: "User",
      subjectId: record.userId,
      after: { sessionsRevoked: revoked.count },
      ipHash: ctx.ipHash,
    });
    return true;
  });
  if (!applied) {
    return { ok: false, reason: "INVALID_OR_EXPIRED" };
  }

  await deps.mailer.send({
    to: record.user.email,
    subject: "Your Used Artifacts password was changed",
    text: "Your password was just changed and every device was signed out. If this wasn't you, reset your password right away and contact support.",
  });
  return { ok: true, userId: record.userId };
}
