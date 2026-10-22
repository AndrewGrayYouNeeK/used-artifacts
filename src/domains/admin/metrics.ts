import type { Db } from "@/lib/db";
import type { FraudDetector } from "@/generated/prisma/enums";
import { kindCreditBalance } from "@/domains/payments/ledger";
import { RELEASED_STATUSES } from "@/domains/orders/state-machine";
import { DAY_MS } from "@/domains/orders/deps";

export interface GmMetrics {
  users: { total: number; newLast30: number; verifiedSellers: number; moderators: number; suspended: number; banned: number };
  storefronts: { total: number; payoutsEnabled: number };
  listings: { live: number; pendingReview: number; sold: number; removed: number };
  sales: {
    last30: { orders: number; gmvCents: number; platformFeeCents: number };
    allTime: { orders: number; gmvCents: number; platformFeeCents: number };
    heldCents: number;
    platformRevenueCents: number;
    openDisputes: number;
    /** Disputed share of orders paid in the last 90 days. */
    disputeRate90: number | null;
  };
  compliance: { open: number; medianHoursToDecision: number | null; approvalRate30: number | null; aiRedFlagRate30: number | null };
  trust: { openSignals: { detector: FraudDetector; count: number }[]; activeSuspensions: number; bansAllTime: number };
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export async function gmMetrics(db: Db, now: Date = new Date()): Promise<GmMetrics> {
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const d90 = new Date(now.getTime() - 90 * DAY_MS);
  const released = { status: { in: [...RELEASED_STATUSES] } };
  const [
    usersTotal,
    usersNew,
    verifiedSellers,
    moderators,
    suspended,
    banned,
    storefronts,
    payoutsEnabled,
    listingGroups,
    sales30,
    salesAll,
    heldCents,
    platformRevenueCents,
    openDisputes,
    paid90,
    disputed90,
    openReviews,
    decided30,
    approved30,
    analyzed30,
    redFlagged30,
    openSignals,
    activeSuspensions,
    bansAllTime,
    medianRows,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: d30 } } }),
    db.identityVerification.count({ where: { status: "VERIFIED" } }),
    db.user.count({ where: { role: "MODERATOR" } }),
    db.user.count({ where: { status: "SUSPENDED" } }),
    db.user.count({ where: { status: "BANNED" } }),
    db.storefront.count(),
    db.storefront.count({ where: { payoutsEnabled: true } }),
    db.listing.groupBy({ by: ["status"], _count: { _all: true } }),
    db.order.aggregate({ where: { ...released, releasedAt: { gte: d30 } }, _count: { _all: true }, _sum: { buyerPriceCents: true, platformFeeCents: true } }),
    db.order.aggregate({ where: released, _count: { _all: true }, _sum: { buyerPriceCents: true, platformFeeCents: true } }),
    kindCreditBalance(db, "BUYER_HELD"),
    kindCreditBalance(db, "PLATFORM_REVENUE"),
    db.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
    db.order.count({ where: { paidAt: { gte: d90 } } }),
    db.order.count({ where: { paidAt: { gte: d90 }, disputes: { some: {} } } }),
    db.complianceReview.count({ where: { status: "OPEN" } }),
    db.complianceReview.count({ where: { decidedAt: { gte: d30 } } }),
    db.complianceReview.count({ where: { decidedAt: { gte: d30 }, status: "APPROVED" } }),
    db.aiAnalysis.count({ where: { createdAt: { gte: d30 }, listingId: { not: null } } }),
    db.aiAnalysis.count({ where: { createdAt: { gte: d30 }, listingId: { not: null }, blocksPublishing: true } }),
    db.fraudSignal.groupBy({ by: ["detector"], where: { status: "OPEN" }, _count: { _all: true } }),
    db.enforcementAction.count({ where: { type: "SUSPENSION", liftedAt: null } }),
    db.enforcementAction.count({ where: { type: "BAN" } }),
    db.$queryRaw<{ hours: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("decidedAt" - "createdAt")) / 3600)::float AS hours
      FROM "ComplianceReview" WHERE "decidedAt" >= ${d30}`,
  ]);
  const listingCount = (status: string) => listingGroups.find((g) => g.status === status)?._count._all ?? 0;
  return {
    users: { total: usersTotal, newLast30: usersNew, verifiedSellers, moderators, suspended, banned },
    storefronts: { total: storefronts, payoutsEnabled },
    listings: { live: listingCount("LIVE"), pendingReview: listingCount("PENDING_REVIEW"), sold: listingCount("SOLD"), removed: listingCount("REMOVED") },
    sales: {
      last30: { orders: sales30._count._all, gmvCents: sales30._sum.buyerPriceCents ?? 0, platformFeeCents: sales30._sum.platformFeeCents ?? 0 },
      allTime: { orders: salesAll._count._all, gmvCents: salesAll._sum.buyerPriceCents ?? 0, platformFeeCents: salesAll._sum.platformFeeCents ?? 0 },
      heldCents,
      platformRevenueCents,
      openDisputes,
      disputeRate90: ratio(disputed90, paid90),
    },
    compliance: {
      open: openReviews,
      medianHoursToDecision: medianRows[0]?.hours ?? null,
      approvalRate30: ratio(approved30, decided30),
      aiRedFlagRate30: ratio(redFlagged30, analyzed30),
    },
    trust: {
      openSignals: openSignals.map((g) => ({ detector: g.detector, count: g._count._all })),
      activeSuspensions,
      bansAllTime,
    },
  };
}

export interface WhatSellsRow {
  categoryId: string;
  categoryName: string;
  closed: number;
  sold: number;
  sellThrough: number;
  medianDaysToSell: number | null;
  avgSaleCents: number | null;
  avgAskCents: number | null;
  authenticatedSold: number;
}

/** Grading Stage 1 data (BUILD_PLAN 4.8a): sell-through by category from closed listings. */
export async function whatSells(db: Db): Promise<WhatSellsRow[]> {
  const rows = await db.$queryRaw<
    {
      categoryId: string;
      categoryName: string;
      closed: bigint;
      sold: bigint;
      medianDays: number | null;
      avgSale: number | null;
      avgAsk: number | null;
      authSold: bigint;
    }[]
  >`
    SELECT o."categoryId", c."name" AS "categoryName",
      count(*) AS closed,
      count(*) FILTER (WHERE o."outcome" = 'SOLD') AS sold,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY o."daysLive") FILTER (WHERE o."outcome" = 'SOLD'))::float AS "medianDays",
      (avg(o."salePriceCents") FILTER (WHERE o."outcome" = 'SOLD'))::float AS "avgSale",
      avg(o."finalAskCents")::float AS "avgAsk",
      count(*) FILTER (WHERE o."outcome" = 'SOLD' AND o."wasAuthenticated") AS "authSold"
    FROM "ListingOutcome" o JOIN "Category" c ON c."id" = o."categoryId"
    GROUP BY o."categoryId", c."name"
    ORDER BY count(*) FILTER (WHERE o."outcome" = 'SOLD') DESC, count(*) DESC
    LIMIT 50`;
  return rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    closed: Number(r.closed),
    sold: Number(r.sold),
    sellThrough: Number(r.closed) === 0 ? 0 : Number(r.sold) / Number(r.closed),
    medianDaysToSell: r.medianDays,
    avgSaleCents: r.avgSale === null ? null : Math.round(r.avgSale),
    avgAskCents: r.avgAsk === null ? null : Math.round(r.avgAsk),
    authenticatedSold: Number(r.authSold),
  }));
}
