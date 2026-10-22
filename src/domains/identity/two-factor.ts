import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email/mailer";
import { decryptString, encryptString, sha256Hex } from "@/lib/crypto";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "@/lib/auth/totp";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";

export interface TwoFactorDeps {
  db: Db;
  /** TWO_FACTOR_ENCRYPTION_KEY */
  twoFactorKey: string;
  mailer?: Mailer;
  now?: () => Date;
}

interface AuditContext {
  ipHash?: string | null;
}

export const TOTP_ISSUER = "Used Artifacts";
export const RECOVERY_CODE_COUNT = 10;

const clock = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
const hashRecoveryCode = (code: string) => sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesLeft: number;
}

export async function twoFactorStatus(db: Db | Tx, userId: string): Promise<TwoFactorStatus> {
  const credential = await db.twoFactorCredential.findUnique({ where: { userId }, select: { enabledAt: true } });
  const recoveryCodesLeft = credential?.enabledAt
    ? await db.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } })
    : 0;
  return { enabled: Boolean(credential?.enabledAt), enabledAt: credential?.enabledAt ?? null, recoveryCodesLeft };
}

export type StartEnrollmentResult =
  | { ok: true; secret: string; otpauthUri: string }
  | { ok: false; reason: "ALREADY_ENABLED" | "USER_NOT_FOUND" };

/** Creates (or replaces) a pending secret. It only takes effect once a code from it is confirmed. */
export async function startTwoFactorEnrollment(deps: TwoFactorDeps, userId: string): Promise<StartEnrollmentResult> {
  const user = await deps.db.user.findUnique({ where: { id: userId }, select: { email: true, twoFactor: { select: { enabledAt: true } } } });
  if (!user) return { ok: false, reason: "USER_NOT_FOUND" };
  if (user.twoFactor?.enabledAt) return { ok: false, reason: "ALREADY_ENABLED" };
  const secret = generateTotpSecret();
  const secretEncrypted = encryptString(deps.twoFactorKey, secret);
  await deps.db.twoFactorCredential.upsert({
    where: { userId },
    create: { userId, secretEncrypted },
    update: { secretEncrypted, lastUsedStep: null },
  });
  return { ok: true, secret, otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: user.email, secret }) };
}

/** The pending secret, so the setup page can redraw the QR code after a wrong code. */
export async function pendingEnrollment(deps: TwoFactorDeps, userId: string): Promise<{ secret: string; otpauthUri: string } | null> {
  const row = await deps.db.twoFactorCredential.findUnique({
    where: { userId },
    select: { secretEncrypted: true, enabledAt: true, user: { select: { email: true } } },
  });
  if (!row || row.enabledAt) return null;
  const secret = decryptString(deps.twoFactorKey, row.secretEncrypted);
  return { secret, otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: row.user.email, secret }) };
}

async function replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
  await tx.twoFactorRecoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })) });
  return codes;
}

export type ConfirmEnrollmentResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "NO_PENDING_ENROLLMENT" | "INVALID_CODE" };

/**
 * Turns two-factor on once the user proves their app produces valid codes.
 * The current session counts as verified, so staff can go straight to /admin.
 */
export async function confirmTwoFactorEnrollment(
  deps: TwoFactorDeps,
  input: { userId: string; code: string; sessionId?: string | null },
  ctx: AuditContext = {},
): Promise<ConfirmEnrollmentResult> {
  const now = clock(deps);
  const row = await deps.db.twoFactorCredential.findUnique({ where: { userId: input.userId }, include: { user: { select: { email: true } } } });
  if (!row || row.enabledAt) return { ok: false, reason: "NO_PENDING_ENROLLMENT" };
  const step = verifyTotp(decryptString(deps.twoFactorKey, row.secretEncrypted), input.code, now, row.lastUsedStep);
  if (step === null) return { ok: false, reason: "INVALID_CODE" };
  const recoveryCodes = await deps.db.$transaction(async (tx) => {
    const claimed = await tx.twoFactorCredential.updateMany({
      where: { userId: input.userId, enabledAt: null, secretEncrypted: row.secretEncrypted },
      data: { enabledAt: now, lastUsedStep: step },
    });
    if (claimed.count !== 1) return null;
    const codes = await replaceRecoveryCodes(tx, input.userId);
    if (input.sessionId) {
      await tx.session.updateMany({ where: { id: input.sessionId, userId: input.userId }, data: { twoFactorVerifiedAt: now } });
    }
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "user.two_factor_enabled",
      subjectType: "User",
      subjectId: input.userId,
      ipHash: ctx.ipHash,
    });
    return codes;
  });
  if (!recoveryCodes) return { ok: false, reason: "NO_PENDING_ENROLLMENT" };
  await deps.mailer?.send({
    to: row.user.email,
    subject: "Two-factor sign-in is on",
    text: "Your Used Artifacts account now asks for an authenticator code when you sign in. If you didn't do this, reset your password right away and contact support.",
  });
  return { ok: true, recoveryCodes };
}

export type SecondFactorMethod = "TOTP" | "RECOVERY_CODE";

/**
 * Checks an authenticator code (or a single-use recovery code) and consumes
 * it, so the same code can't be used twice. Returns null if invalid or if
 * two-factor isn't on.
 */
export async function consumeSecondFactor(
  deps: Pick<TwoFactorDeps, "db" | "twoFactorKey" | "now">,
  userId: string,
  code: string,
): Promise<SecondFactorMethod | null> {
  const credential = await deps.db.twoFactorCredential.findUnique({ where: { userId } });
  if (!credential?.enabledAt) return null;
  if (looksLikeRecoveryCode(code)) {
    const used = await deps.db.twoFactorRecoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
      data: { usedAt: clock(deps) },
    });
    return used.count === 1 ? "RECOVERY_CODE" : null;
  }
  const step = verifyTotp(decryptString(deps.twoFactorKey, credential.secretEncrypted), code, clock(deps), credential.lastUsedStep);
  if (step === null) return null;
  const claimed = await deps.db.twoFactorCredential.updateMany({
    where: {
      userId,
      secretEncrypted: credential.secretEncrypted,
      OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
    },
    data: { lastUsedStep: step },
  });
  return claimed.count === 1 ? "TOTP" : null;
}

export type DisableTwoFactorResult = { ok: true } | { ok: false; reason: "NOT_ENABLED" | "INVALID_CODE" };

/** The caller checks the password; this needs a current code too. Other sessions lose their verified flag. */
export async function disableTwoFactor(
  deps: TwoFactorDeps,
  input: { userId: string; code: string },
  ctx: AuditContext = {},
): Promise<DisableTwoFactorResult> {
  const status = await twoFactorStatus(deps.db, input.userId);
  if (!status.enabled) return { ok: false, reason: "NOT_ENABLED" };
  const method = await consumeSecondFactor(deps, input.userId, input.code);
  if (!method) return { ok: false, reason: "INVALID_CODE" };
  const user = await deps.db.$transaction(async (tx) => {
    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: input.userId } });
    await tx.twoFactorCredential.delete({ where: { userId: input.userId } });
    await tx.session.updateMany({ where: { userId: input.userId }, data: { twoFactorVerifiedAt: null } });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "user.two_factor_disabled",
      subjectType: "User",
      subjectId: input.userId,
      after: { method },
      ipHash: ctx.ipHash,
    });
    return tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true } });
  });
  await deps.mailer?.send({
    to: user.email,
    subject: "Two-factor sign-in was turned off",
    text: "Your Used Artifacts account no longer asks for an authenticator code. If you didn't do this, reset your password right away and contact support.",
  });
  return { ok: true };
}

export type RegenerateRecoveryCodesResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "NOT_ENABLED" | "INVALID_CODE" };

export async function regenerateRecoveryCodes(
  deps: TwoFactorDeps,
  input: { userId: string; code: string },
  ctx: AuditContext = {},
): Promise<RegenerateRecoveryCodesResult> {
  const status = await twoFactorStatus(deps.db, input.userId);
  if (!status.enabled) return { ok: false, reason: "NOT_ENABLED" };
  if ((await consumeSecondFactor(deps, input.userId, input.code)) !== "TOTP") return { ok: false, reason: "INVALID_CODE" };
  const recoveryCodes = await deps.db.$transaction(async (tx) => {
    const codes = await replaceRecoveryCodes(tx, input.userId);
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "user.two_factor_recovery_codes_regenerated",
      subjectType: "User",
      subjectId: input.userId,
      ipHash: ctx.ipHash,
    });
    return codes;
  });
  return { ok: true, recoveryCodes };
}

/**
 * Server-side reset for a locked-out user (lost phone and recovery codes),
 * run from a shell by someone with production access. Never exposed in the app.
 */
export async function resetTwoFactorFromConsole(db: Db, email: string, reason: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
  if (!user) return false;
  await db.$transaction(async (tx) => {
    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.twoFactorCredential.deleteMany({ where: { userId: user.id } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action: "user.two_factor_reset_console",
      subjectType: "User",
      subjectId: user.id,
      after: { reason },
    });
  });
  return true;
}
