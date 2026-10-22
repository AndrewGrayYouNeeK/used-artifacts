import type { Db } from "@/lib/db";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import { recomputeVolumeBadges } from "@/domains/growth/badges";
import { freezeOrderEarnings } from "@/domains/growth/referrals";
import { RELEASED_STATUSES } from "@/domains/orders/state-machine";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CIRCLE_WINDOW_DAYS = 90;
export const MAX_CYCLE_LENGTH = 4;
const SCAN_ACTION = "trust.circle_trade_scan";
/** The scan is nightly; the cron runs every 15 minutes, so skip if one ran recently. */
const SCAN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export type CycleHit = { userIds: string[]; orderIds: string[] };
export type ReturnHit = { earlierOwnerUserId: string; firstOrderId: string; returnOrderId: string; sharedHashes: string[] };

/**
 * Directed cycles of 2..4 distinct accounts in the released-order graph
 * (seller → buyer) over the window. Each cycle is reported once, rooted at its
 * smallest user id; `orderIds` holds every released order on its edges.
 */
export async function findTradeCycles(db: Db | Tx, since: Date, maxLength = MAX_CYCLE_LENGTH): Promise<CycleHit[]> {
  const statuses = [...RELEASED_STATUSES];
  const rows = await db.$queryRaw<{ users: string[]; orders: string[] }[]>`
    WITH RECURSIVE edges AS (
      SELECT "sellerUserId" AS s, "buyerUserId" AS b, array_agg(id ORDER BY id) AS orders
      FROM "Order"
      WHERE status::text = ANY(${statuses}) AND "releasedAt" >= ${since} AND "sellerUserId" <> "buyerUserId"
      GROUP BY 1, 2
    ), walk AS (
      SELECT s AS root, b AS last, ARRAY[s, b] AS users, orders, 1 AS depth FROM edges
      UNION ALL
      SELECT w.root, e.b, w.users || e.b, w.orders || e.orders, w.depth + 1
      FROM walk w JOIN edges e ON e.s = w.last
      WHERE w.depth < ${maxLength} AND w.last <> w.root AND (e.b = w.root OR NOT e.b = ANY(w.users))
    )
    SELECT users[1:array_length(users, 1) - 1] AS users, orders
    FROM walk
    WHERE last = root AND root = (SELECT min(u) FROM unnest(users) u)`;
  return rows.map((r) => ({ userIds: r.users, orderIds: [...new Set(r.orders)].sort() }));
}

/**
 * An item that comes back to someone who sold it: a released sale by X, then a
 * later released order of a listing with an identical photo hash that X buys
 * or sells again.
 */
export async function findItemReturns(db: Db | Tx, since: Date): Promise<ReturnHit[]> {
  const statuses = [...RELEASED_STATUSES];
  const rows = await db.$queryRaw<{ owner: string; first: string; back: string; hashes: string[] }[]>`
    SELECT o1."sellerUserId" AS owner, o1.id AS first, o2.id AS back,
           ARRAY(SELECT unnest(f1."pHashes") INTERSECT SELECT unnest(f2."pHashes")) AS hashes
    FROM "Order" o1
    JOIN "ItemFingerprint" f1 ON f1."listingId" = o1."listingId"
    JOIN "ItemFingerprint" f2 ON f2."listingId" <> o1."listingId" AND f2."pHashes" && f1."pHashes"
    JOIN "Order" o2 ON o2."listingId" = f2."listingId"
    WHERE o1.status::text = ANY(${statuses}) AND o2.status::text = ANY(${statuses})
      AND o1."releasedAt" >= ${since} AND o2."releasedAt" >= ${since}
      AND o2."createdAt" > o1."createdAt"
      AND (o2."buyerUserId" = o1."sellerUserId" OR o2."sellerUserId" = o1."sellerUserId")`;
  return rows.map((r) => ({ earlierOwnerUserId: r.owner, firstOrderId: r.first, returnOrderId: r.back, sharedHashes: r.hashes }));
}

async function linkedPairs(tx: Tx, userIds: string[]): Promise<number> {
  return tx.accountLink.count({ where: { userAId: { in: userIds }, userBId: { in: userIds } } });
}

/**
 * Raises one signal per finding (deduplicated), links it to every order involved,
 * freezes unpaid referral credit on those orders, and recounts the participants'
 * volume badges (orders under an open signal don't count). Returns true if new.
 */
async function raiseCircleSignal(
  tx: Tx,
  input: { dedupeKey: string; subjectOrderId: string; orderIds: string[]; score: number; evidence: Record<string, unknown> },
): Promise<boolean> {
  const existing = await tx.fraudSignal.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
  if (existing) return false;
  const signal = await tx.fraudSignal.create({
    data: {
      detector: "CIRCLE_TRADE",
      subjectType: "Order",
      subjectId: input.subjectOrderId,
      score: input.score,
      evidence: JSON.parse(JSON.stringify(input.evidence)),
      dedupeKey: input.dedupeKey,
      orders: { create: input.orderIds.map((orderId) => ({ orderId })) },
    },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "fraud.signal_created",
    subjectType: "FraudSignal",
    subjectId: signal.id,
    after: { detector: "CIRCLE_TRADE", orderIds: input.orderIds, score: input.score },
  });
  const reason = "Order is part of a suspected circle trade under review.";
  for (const orderId of input.orderIds) await freezeOrderEarnings(tx, orderId, reason);
  const orders = await tx.order.findMany({ where: { id: { in: input.orderIds } }, select: { buyerUserId: true, sellerUserId: true } });
  for (const userId of new Set(orders.flatMap((o) => [o.buyerUserId, o.sellerUserId]))) await recomputeVolumeBadges(tx, userId);
  return true;
}

export type CircleScanResult = { skipped: true } | { skipped: false; cycles: number; returns: number; newSignals: number };

/** Nightly circle-trade scan (BUILD_PLAN 5.3). Signals go to staff; nothing is enforced automatically. */
export async function runCircleTradeScan(
  deps: { db: Db; now?: () => Date },
  opts: { force?: boolean } = {},
): Promise<CircleScanResult> {
  const now = deps.now?.() ?? new Date();
  if (!opts.force) {
    const recent = await deps.db.auditEvent.findFirst({
      where: { action: SCAN_ACTION, at: { gte: new Date(now.getTime() - SCAN_INTERVAL_MS) } },
      select: { id: true },
    });
    if (recent) return { skipped: true };
  }
  const since = new Date(now.getTime() - CIRCLE_WINDOW_DAYS * DAY_MS);
  const [cycles, returns] = await Promise.all([findTradeCycles(deps.db, since), findItemReturns(deps.db, since)]);
  let newSignals = 0;
  for (const cycle of cycles) {
    const created = await deps.db.$transaction(async (tx) => {
      const links = await linkedPairs(tx, cycle.userIds);
      return raiseCircleSignal(tx, {
        dedupeKey: `cycle:${cycle.orderIds.join(",")}`,
        subjectOrderId: cycle.orderIds[0],
        orderIds: cycle.orderIds,
        score: Math.min(95, 50 + 10 * (MAX_CYCLE_LENGTH + 1 - cycle.userIds.length) + 15 * Math.min(links, 2)),
        evidence: { kind: "CYCLE", userIds: cycle.userIds, orderIds: cycle.orderIds, linkedPairs: links, windowDays: CIRCLE_WINDOW_DAYS },
      });
    });
    if (created) newSignals++;
  }
  for (const hit of returns) {
    const created = await deps.db.$transaction((tx) =>
      raiseCircleSignal(tx, {
        dedupeKey: `return:${hit.firstOrderId},${hit.returnOrderId}`,
        subjectOrderId: hit.returnOrderId,
        orderIds: [hit.firstOrderId, hit.returnOrderId],
        score: 70,
        evidence: { kind: "ITEM_RETURNED", ...hit },
      }),
    );
    if (created) newSignals++;
  }
  await deps.db.$transaction((tx) =>
    writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action: SCAN_ACTION,
      subjectType: "System",
      subjectId: "circle-trade",
      after: { since: since.toISOString(), cycles: cycles.length, returns: returns.length, newSignals },
    }),
  );
  return { skipped: false, cycles: cycles.length, returns: returns.length, newSignals };
}
