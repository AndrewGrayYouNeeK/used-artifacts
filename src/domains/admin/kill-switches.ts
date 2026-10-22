import type { Db } from "@/lib/db";
import type { KillSwitchKey } from "@/generated/prisma/enums";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";

export const KILL_SWITCHES: readonly { key: KillSwitchKey; label: string; effect: string }[] = [
  { key: "SIGNUPS", label: "New signups", effect: "The signup form refuses new accounts. Existing members can still sign in." },
  { key: "LISTINGS", label: "New listings", effect: "Sellers can't submit listings. Live listings stay up." },
  { key: "CHECKOUT", label: "Checkout", effect: "Buy now and auction payment are refused. Paid orders continue." },
  { key: "BIDDING", label: "Bidding", effect: "New bids are refused (auctions are also behind AUCTIONS_ENABLED)." },
  {
    key: "PAYOUTS",
    label: "Payouts",
    effect: "Seller transfers and referral payouts wait. Money stays held and goes out automatically when resumed.",
  },
  {
    key: "AI_ANALYZER",
    label: "AI photo analyzer",
    effect: "No model calls. Submissions are recorded as analysis unavailable and staff review them as usual.",
  },
];

export async function isPaused(db: Db | Tx, key: KillSwitchKey): Promise<boolean> {
  const row = await db.killSwitch.findUnique({ where: { key }, select: { paused: true } });
  return row?.paused ?? false;
}

export interface KillSwitchState {
  key: KillSwitchKey;
  label: string;
  effect: string;
  paused: boolean;
  reason: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function killSwitchStates(db: Db): Promise<KillSwitchState[]> {
  const rows = await db.killSwitch.findMany({ include: { updatedBy: { select: { displayName: true } } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return KILL_SWITCHES.map(({ key, label, effect }) => {
    const row = byKey.get(key);
    return {
      key,
      label,
      effect,
      paused: row?.paused ?? false,
      reason: row?.reason ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy?.displayName ?? null,
    };
  });
}

export type SetKillSwitchResult = { ok: true } | { ok: false; reason: "REASON_REQUIRED" | "OWNER_ONLY" | "NOT_STAFF" | "UNCHANGED" };

/**
 * Any staff member can pause (an emergency brake); only the owner can resume.
 * Every change is audited with the reason.
 */
export async function setKillSwitch(
  deps: { db: Db },
  input: { actorId: string; key: KillSwitchKey; paused: boolean; reason: string },
  ctx: { ipHash?: string | null } = {},
): Promise<SetKillSwitchResult> {
  const actor = await deps.db.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== "ACTIVE" || (actor.role !== "OWNER" && actor.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" };
  if (!input.paused && actor.role !== "OWNER") return { ok: false, reason: "OWNER_ONLY" };
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  return deps.db.$transaction(async (tx) => {
    const before = await tx.killSwitch.findUnique({ where: { key: input.key } });
    if ((before?.paused ?? false) === input.paused) return { ok: false, reason: "UNCHANGED" } as const;
    await tx.killSwitch.upsert({
      where: { key: input.key },
      create: { key: input.key, paused: input.paused, reason, updatedById: input.actorId },
      update: { paused: input.paused, reason, updatedById: input.actorId },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: input.paused ? "platform.kill_switch_paused" : "platform.kill_switch_resumed",
      subjectType: "KillSwitch",
      subjectId: input.key,
      before: { paused: before?.paused ?? false, reason: before?.reason ?? null },
      after: { paused: input.paused, reason },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}
