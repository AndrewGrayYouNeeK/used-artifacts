import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email/mailer";
import { sha256Hex } from "@/lib/crypto";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";

/** No 0/O, 1/I/L, so codes survive being read aloud or handwritten. */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 12;
export const MAX_INVITE_USES = 1000;
export const MAX_INVITE_DAYS = 365;

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatInviteCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

export function generateInviteCode(): string {
  const chars = Array.from(randomBytes(INVITE_LENGTH), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
  return formatInviteCode(chars);
}

const hashInviteCode = (code: string) => sha256Hex(`beta-invite:${normalizeInviteCode(code)}`);

export interface BetaInviteDeps {
  db: Db;
  appUrl: string;
  mailer?: Mailer;
  now?: () => Date;
}

export type CreateBetaInviteResult =
  | { ok: true; inviteId: string; code: string; link: string; emailed: boolean }
  | { ok: false; reason: "OWNER_ONLY" | "NOTE_REQUIRED" | "INVALID_USES" | "INVALID_EXPIRY" | "INVALID_EMAIL" };

/** Owner-only. The code is returned once; only its hash is stored. */
export async function createBetaInvite(
  deps: BetaInviteDeps,
  input: { actorId: string; note: string; email?: string | null; maxUses: number; expiresInDays?: number | null; sendEmail?: boolean },
  ctx: { ipHash?: string | null } = {},
): Promise<CreateBetaInviteResult> {
  const actor = await deps.db.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true, displayName: true } });
  if (!actor || actor.role !== "OWNER" || actor.status !== "ACTIVE") return { ok: false, reason: "OWNER_ONLY" };
  const note = input.note.trim();
  if (note.length < 2 || note.length > 200) return { ok: false, reason: "NOTE_REQUIRED" };
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > MAX_INVITE_USES) return { ok: false, reason: "INVALID_USES" };
  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS)) return { ok: false, reason: "INVALID_EXPIRY" };
  const email = input.email?.trim().toLowerCase() || null;
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) return { ok: false, reason: "INVALID_EMAIL" };

  const now = deps.now ? deps.now() : new Date();
  const code = generateInviteCode();
  const normalized = normalizeInviteCode(code);
  const invite = await deps.db.$transaction(async (tx) => {
    const created = await tx.betaInvite.create({
      data: {
        codeHash: hashInviteCode(code),
        codeHint: normalized.slice(-4),
        note,
        email,
        maxUses: input.maxUses,
        expiresAt: days ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000) : null,
        createdById: input.actorId,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "beta.invite_created",
      subjectType: "BetaInvite",
      subjectId: created.id,
      after: { note, email, maxUses: created.maxUses, expiresAt: created.expiresAt, codeHint: created.codeHint },
      ipHash: ctx.ipHash,
    });
    return created;
  });
  const link = `${deps.appUrl}/signup?invite=${encodeURIComponent(code)}`;
  const emailed = Boolean(email && input.sendEmail && deps.mailer);
  if (emailed && email && deps.mailer) {
    await deps.mailer.send({
      to: email,
      subject: "Your invitation to the Used Artifacts beta",
      text: `${actor.displayName} invited you to the Used Artifacts closed beta, a marketplace for artifacts with verified provenance.\n\nCreate your account here:\n\n${link}\n\nYour invite code is ${code}${invite.expiresAt ? ` and it expires on ${invite.expiresAt.toISOString().slice(0, 10)}` : ""}. It only works with this email address.`,
    });
  }
  return { ok: true, inviteId: invite.id, code, link, emailed };
}

/**
 * Claims one use of an invite inside the signup transaction. The single
 * UPDATE checks uses, revocation, expiry, and the email lock atomically, so
 * concurrent signups can't overspend an invite.
 */
export async function redeemBetaInvite(tx: Tx, input: { code: string; userId: string; email: string; now: Date }): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "BetaInvite" SET "useCount" = "useCount" + 1
    WHERE "codeHash" = ${hashInviteCode(input.code)}
      AND "useCount" < "maxUses"
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > ${input.now})
      AND ("email" IS NULL OR "email" = ${input.email.toLowerCase()})
    RETURNING "id"`;
  const invite = rows[0];
  if (!invite) return false;
  await tx.betaInviteRedemption.create({ data: { inviteId: invite.id, userId: input.userId } });
  await writeAuditEvent(tx, {
    actorUserId: input.userId,
    actorType: "USER",
    action: "beta.invite_redeemed",
    subjectType: "BetaInvite",
    subjectId: invite.id,
  });
  return true;
}

export type RevokeBetaInviteResult = { ok: true } | { ok: false; reason: "OWNER_ONLY" | "NOT_FOUND" | "ALREADY_REVOKED" };

/** Stops further signups with the code; accounts already created are unaffected. */
export async function revokeBetaInvite(
  deps: Pick<BetaInviteDeps, "db" | "now">,
  input: { actorId: string; inviteId: string },
  ctx: { ipHash?: string | null } = {},
): Promise<RevokeBetaInviteResult> {
  const actor = await deps.db.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true } });
  if (!actor || actor.role !== "OWNER" || actor.status !== "ACTIVE") return { ok: false, reason: "OWNER_ONLY" };
  const now = deps.now ? deps.now() : new Date();
  return deps.db.$transaction(async (tx) => {
    const invite = await tx.betaInvite.findUnique({ where: { id: input.inviteId } });
    if (!invite) return { ok: false, reason: "NOT_FOUND" } as const;
    const updated = await tx.betaInvite.updateMany({ where: { id: invite.id, revokedAt: null }, data: { revokedAt: now } });
    if (updated.count !== 1) return { ok: false, reason: "ALREADY_REVOKED" } as const;
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "beta.invite_revoked",
      subjectType: "BetaInvite",
      subjectId: invite.id,
      after: { useCount: invite.useCount },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}

export type InviteState = "ACTIVE" | "USED_UP" | "EXPIRED" | "REVOKED";

export function inviteState(invite: { useCount: number; maxUses: number; expiresAt: Date | null; revokedAt: Date | null }, now: Date): InviteState {
  if (invite.revokedAt) return "REVOKED";
  if (invite.useCount >= invite.maxUses) return "USED_UP";
  if (invite.expiresAt && invite.expiresAt <= now) return "EXPIRED";
  return "ACTIVE";
}

export async function listBetaInvites(db: Db, take = 200) {
  return db.betaInvite.findMany({
    orderBy: { createdAt: "desc" },
    take,
    include: {
      createdBy: { select: { displayName: true } },
      redemptions: { orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, displayName: true, email: true } } } },
    },
  });
}
