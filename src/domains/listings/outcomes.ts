import type { ListingOutcomeType } from "@/generated/prisma/enums";
import type { Tx } from "@/domains/audit/audit";
import { DAY_MS } from "@/domains/orders/deps";

interface AiValueRange {
  valueLowCents?: unknown;
  valueHighCents?: unknown;
}

const intOrNull = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * Snapshots a listing's sales outcome when it leaves LIVE (Grading Stage 1
 * data, BUILD_PLAN 4.8a). Written once; later edits never rewrite it.
 */
export async function recordListingOutcome(
  tx: Tx,
  input: { listingId: string; outcome: ListingOutcomeType; salePriceCents?: number | null; closedAt: Date },
) {
  if (await tx.listingOutcome.findUnique({ where: { listingId: input.listingId }, select: { id: true } })) return;
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: input.listingId },
    include: {
      category: { select: { vertical: true } },
      priceChanges: { orderBy: { changedAt: "asc" }, take: 1 },
      _count: { select: { photos: true } },
      aiAnalyses: { orderBy: { createdAt: "desc" }, take: 1 },
      gradingSubmissions: {
        select: { results: { where: { status: "PUBLISHED" }, select: { tierAwarded: true }, take: 1 } },
      },
    },
  });
  const stats = await tx.listingDailyStat.aggregate({
    where: { listingId: listing.id },
    _sum: { views: true, saves: true },
  });
  const grade = listing.gradingSubmissions.flatMap((s) => s.results)[0] ?? null;
  const ai = listing.aiAnalyses[0];
  const aiRange = (ai?.normalizedOutput ?? {}) as AiValueRange;
  const start = listing.publishedAt ?? listing.createdAt;
  await tx.listingOutcome.create({
    data: {
      listingId: listing.id,
      categoryId: listing.categoryId,
      vertical: listing.category.vertical,
      outcome: input.outcome,
      firstAskCents: listing.priceChanges[0]?.oldAskingPriceCents ?? listing.askingPriceCents,
      finalAskCents: listing.askingPriceCents,
      salePriceCents: input.salePriceCents ?? null,
      daysLive: Math.max(0, Math.floor((input.closedAt.getTime() - start.getTime()) / DAY_MS)),
      totalViews: stats._sum.views ?? 0,
      totalSaves: stats._sum.saves ?? 0,
      photoCount: listing._count.photos,
      sellerConditionGrade: listing.sellerConditionGrade,
      wasAuthenticated: grade !== null,
      gradingTier: grade?.tierAwarded ?? null,
      aiValueLowCents: intOrNull(aiRange.valueLowCents),
      aiValueHighCents: intOrNull(aiRange.valueHighCents),
      aiUncertainty: ai?.uncertainty ?? null,
      closedAt: input.closedAt,
    },
  });
}
