import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email/mailer";
import { platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent } from "@/domains/audit/audit";
import { KILL_SWITCHES } from "./kill-switches";

export interface StaffQueueCounts {
  openSignals: number;
  pendingCompliance: number;
  openFeedback: number;
  openDisputes: number;
  fraudHolds: number;
  stuckTransfers: number;
  pendingRetractions: number;
  openAppeals: number;
  pausedSwitches: string[];
}

export async function staffQueueCounts(db: Db): Promise<StaffQueueCounts> {
  const openSignals = await db.fraudSignal.count({ where: { status: "OPEN" } });
  const pendingCompliance = await db.complianceReview.count({ where: { status: { in: ["OPEN", "ESCALATED"] } } });
  const openFeedback = await db.feedback.count({ where: { status: "OPEN" } });
  const openDisputes = await db.dispute.count({ where: { status: { not: "RESOLVED" } } });
  const fraudHolds = await db.order.count({ where: { releaseHold: true, status: { in: ["PAID_HELD", "SHIPPED", "DELIVERED"] } } });
  const stuckTransfers = await db.transfer.count({ where: { status: "PENDING", attempts: { gt: 0 } } });
  const pendingRetractions = await db.bidRetraction.count({ where: { status: "PENDING" } });
  const openAppeals = await db.appeal.count({ where: { status: "OPEN" } });
  const paused = await db.killSwitch.findMany({ where: { paused: true }, select: { key: true } });
  const labels = new Map(KILL_SWITCHES.map((k) => [k.key, k.label]));
  return {
    openSignals,
    pendingCompliance,
    openFeedback,
    openDisputes,
    fraudHolds,
    stuckTransfers,
    pendingRetractions,
    openAppeals,
    pausedSwitches: paused.map((p) => labels.get(p.key) ?? p.key),
  };
}

/** Midnight UTC of the given instant, the key for daily rows. */
export function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type RecordDailyReviewResult = { ok: true } | { ok: false; reason: "NOT_STAFF" | "ALREADY_DONE" };

/**
 * Staff sign off that today's fraud signals and queues were looked at
 * (BUILD_PLAN phase 7: daily fraud review). The counts are snapshotted.
 */
export async function recordDailyReview(
  deps: { db: Db; now?: () => Date },
  input: { actorId: string; notes: string },
  ctx: { ipHash?: string | null } = {},
): Promise<RecordDailyReviewResult> {
  const actor = await deps.db.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== "ACTIVE" || (actor.role !== "OWNER" && actor.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" };
  const now = deps.now ? deps.now() : new Date();
  const counts = await staffQueueCounts(deps.db);
  try {
    await deps.db.$transaction(async (tx) => {
      const review = await tx.dailyReview.create({
        data: {
          day: utcDay(now),
          reviewedById: input.actorId,
          notes: input.notes.trim().slice(0, 2000) || null,
          openSignals: counts.openSignals,
          pendingCompliance: counts.pendingCompliance,
          openFeedback: counts.openFeedback,
        },
      });
      await writeAuditEvent(tx, {
        actorUserId: input.actorId,
        actorType: "ADMIN",
        action: "trust.daily_review_recorded",
        subjectType: "DailyReview",
        subjectId: review.id,
        after: { ...counts, notes: review.notes },
        ipHash: ctx.ipHash,
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, reason: "ALREADY_DONE" };
    throw err;
  }
  return { ok: true };
}

export async function recentDailyReviews(db: Db, take = 14) {
  return db.dailyReview.findMany({ orderBy: { day: "desc" }, take, include: { reviewedBy: { select: { displayName: true } } } });
}

export interface DigestDeps {
  db: Db;
  mailer: Mailer;
  appUrl: string;
  now?: () => Date;
  platform?: PlatformConfig;
}

export type DigestReport = { sent: false; reason: "TOO_EARLY" | "ALREADY_SENT" } | { sent: true; recipients: number };

/**
 * Emails every active staff member a summary of the queues, once per UTC
 * day, on the first scheduled run at or after DAILY_DIGEST_HOUR_UTC. The
 * DailyDigest row is claimed first, so concurrent runs send it once.
 */
export async function sendDailyDigest(deps: DigestDeps): Promise<DigestReport> {
  const now = deps.now ? deps.now() : new Date();
  const config = deps.platform ?? platform;
  if (now.getUTCHours() < config.dailyDigestHourUtc) return { sent: false, reason: "TOO_EARLY" };
  const day = utcDay(now);
  const staff = await deps.db.user.findMany({
    where: { role: { in: ["OWNER", "MODERATOR"] }, status: "ACTIVE", emailVerifiedAt: { not: null } },
    select: { email: true },
  });
  try {
    await deps.db.dailyDigest.create({ data: { day, recipients: staff.length } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { sent: false, reason: "ALREADY_SENT" };
    throw err;
  }
  const counts = await staffQueueCounts(deps.db);
  const yesterday = await deps.db.dailyReview.findUnique({ where: { day: new Date(day.getTime() - 24 * 60 * 60 * 1000) }, select: { id: true } });
  const lines = [
    `Daily review for ${day.toISOString().slice(0, 10)} (UTC).`,
    "",
    `Open fraud signals: ${counts.openSignals}`,
    `Listings waiting for compliance review: ${counts.pendingCompliance}`,
    `Open disputes: ${counts.openDisputes}`,
    `Orders on fraud hold: ${counts.fraudHolds}`,
    `Seller transfers retrying: ${counts.stuckTransfers}`,
    `Bid retraction requests: ${counts.pendingRetractions}`,
    `Open appeals: ${counts.openAppeals}`,
    `Open beta feedback: ${counts.openFeedback}`,
    `Paused kill switches: ${counts.pausedSwitches.length ? counts.pausedSwitches.join(", ") : "none"}`,
    "",
    yesterday ? "Yesterday's review was signed off." : "Yesterday's review was NOT signed off.",
    "",
    `Review and sign off: ${deps.appUrl}/admin/trust`,
  ];
  for (const s of staff) {
    await deps.mailer.send({ to: s.email, subject: `Used Artifacts daily review: ${counts.openSignals} open signals`, text: lines.join("\n") });
  }
  return { sent: true, recipients: staff.length };
}
