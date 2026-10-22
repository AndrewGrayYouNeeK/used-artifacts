import { platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import { RELEASED_STATUSES } from "@/domains/orders/state-machine";
import { stronglyLinkedUserIds } from "@/domains/trust/linkage";

export const BETA_FOUNDER_CODE = "BETA_FOUNDER";

type Side = "SALES" | "PURCHASES";

/**
 * Released orders that count toward volume badges: no chargeback, no open or
 * confirmed fraud signal on the order, the other party isn't a linked account,
 * and at most `perCounterparty` orders with the same person.
 */
export async function qualifyingOrderCount(tx: Tx, userId: string, side: Side, perCounterparty: number): Promise<number> {
  const own = side === "SALES" ? { sellerUserId: userId } : { buyerUserId: userId };
  const orders = await tx.order.findMany({
    where: { ...own, status: { in: [...RELEASED_STATUSES] }, disputes: { none: { isChargeback: true } } },
    select: { id: true, buyerUserId: true, sellerUserId: true },
  });
  if (orders.length === 0) return 0;
  const [flagged, linked] = await Promise.all([
    tx.fraudSignal.findMany({
      where: { subjectType: "Order", subjectId: { in: orders.map((o) => o.id) }, status: { in: ["OPEN", "CONFIRMED"] } },
      select: { subjectId: true },
    }),
    stronglyLinkedUserIds(tx, userId),
  ]);
  const excluded = new Set(flagged.map((f) => f.subjectId));
  const linkedIds = new Set(linked);
  const perPerson = new Map<string, number>();
  let count = 0;
  for (const o of orders) {
    const other = side === "SALES" ? o.buyerUserId : o.sellerUserId;
    if (excluded.has(o.id) || linkedIds.has(other)) continue;
    const n = perPerson.get(other) ?? 0;
    if (n >= perCounterparty) continue;
    perPerson.set(other, n + 1);
    count++;
  }
  return count;
}

function threshold(criteria: unknown): { side: Side; count: number } | null {
  if (!criteria || typeof criteria !== "object") return null;
  const c = criteria as Record<string, unknown>;
  if (typeof c.releasedSalesCount === "number") return { side: "SALES", count: c.releasedSalesCount };
  if (typeof c.releasedPurchasesCount === "number") return { side: "PURCHASES", count: c.releasedPurchasesCount };
  return null;
}

/**
 * Awards and revokes VOLUME badges from the current qualifying counts. A badge
 * revoked by staff (an unlifted BADGE_REVOKED action) is never re-awarded here.
 * The Proprietor badge is not a Badge row, so this can't touch it.
 */
export async function recomputeVolumeBadges(
  tx: Tx,
  userId: string,
  opts: { config?: PlatformConfig; now?: Date } = {},
): Promise<{ awarded: string[]; revoked: string[] }> {
  const config = opts.config ?? platform;
  const now = opts.now ?? new Date();
  const badges = await tx.badge.findMany({ where: { kind: "VOLUME" } });
  const awards = await tx.userBadge.findMany({
    where: { userId, badgeId: { in: badges.map((b) => b.id) } },
    include: { enforcementActions: { where: { type: "BADGE_REVOKED", liftedAt: null }, select: { id: true } } },
  });
  const counts = new Map<Side, number>();
  const countFor = async (side: Side) => {
    if (!counts.has(side)) counts.set(side, await qualifyingOrderCount(tx, userId, side, config.badgeMaxSalesPerCounterparty));
    return counts.get(side)!;
  };

  const awarded: string[] = [];
  const revoked: string[] = [];
  for (const badge of badges) {
    const rule = threshold(badge.criteria);
    if (!rule) continue;
    const count = await countFor(rule.side);
    const qualifies = count >= rule.count;
    const award = awards.find((a) => a.badgeId === badge.id);
    const basisSnapshot = { side: rule.side, qualifyingCount: count, threshold: rule.count, at: now.toISOString() };
    if (qualifies && !award) {
      await tx.userBadge.create({ data: { userId, badgeId: badge.id, awardedAt: now, basisSnapshot } });
      awarded.push(badge.code);
    } else if (qualifies && award?.revokedAt && award.enforcementActions.length === 0) {
      await tx.userBadge.update({ where: { id: award.id }, data: { revokedAt: null, awardedAt: now, basisSnapshot } });
      awarded.push(badge.code);
    } else if (!qualifies && award && !award.revokedAt) {
      await tx.userBadge.update({ where: { id: award.id }, data: { revokedAt: now, basisSnapshot } });
      revoked.push(badge.code);
    }
  }
  for (const [codes, action] of [
    [awarded, "badge.awarded"],
    [revoked, "badge.revoked"],
  ] as const) {
    if (codes.length === 0) continue;
    await writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action,
      subjectType: "User",
      subjectId: userId,
      after: { badges: codes, sales: counts.get("SALES") ?? null, purchases: counts.get("PURCHASES") ?? null },
    });
  }
  return { awarded, revoked };
}

/**
 * Cosmetic Beta Founder badge for the first sellers to go live (owner decision B5),
 * capped by BETA_FOUNDER_LIMIT here and by the badge's firstNSellers in the database.
 */
export async function awardBetaFounder(
  tx: Tx,
  userId: string,
  opts: { config?: PlatformConfig; now?: Date } = {},
): Promise<boolean> {
  const config = opts.config ?? platform;
  const badge = await tx.badge.findUnique({ where: { code: BETA_FOUNDER_CODE } });
  if (!badge) return false;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('beta_founder_cap'))`;
  const [existing, awardedCount] = await Promise.all([
    tx.userBadge.findUnique({ where: { userId_badgeId: { userId, badgeId: badge.id } }, select: { id: true } }),
    tx.userBadge.count({ where: { badgeId: badge.id } }),
  ]);
  const dbCap = (badge.criteria as { firstNSellers?: number } | null)?.firstNSellers ?? config.betaFounderLimit;
  if (existing || awardedCount >= Math.min(config.betaFounderLimit, dbCap)) return false;
  await tx.userBadge.create({
    data: { userId, badgeId: badge.id, awardedAt: opts.now ?? new Date(), basisSnapshot: { sellerNumber: awardedCount + 1 } },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "badge.awarded",
    subjectType: "User",
    subjectId: userId,
    after: { badges: [BETA_FOUNDER_CODE], sellerNumber: awardedCount + 1 },
  });
  return true;
}
