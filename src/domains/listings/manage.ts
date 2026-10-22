import type { Db } from "@/lib/db";
import { writeAuditEvent } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { cancelOpenAuction } from "@/domains/auctions/lifecycle";
import { recordListingOutcome } from "./outcomes";
import { MAX_ASKING_CENTS, MIN_ASKING_CENTS } from "./rules";

export interface ManageDeps {
  db: Db;
  now?: () => Date;
}

const clock = (deps: ManageDeps) => (deps.now ? deps.now() : new Date());

export type ChangePriceResult = { ok: true } | { ok: false; reason: "NOT_FOUND" | "NOT_EDITABLE" | "INVALID_PRICE" | "UNCHANGED" };

/**
 * Price changes on live listings don't need a new compliance review (the
 * provenance facts are unchanged) but every change is kept for the
 * "what sells" data (ListingPriceChange).
 */
export async function changeAskingPrice(
  deps: ManageDeps,
  input: { sellerUserId: string; listingId: string; askingPriceCents: number },
  ctx: RequestContext = {},
): Promise<ChangePriceResult> {
  if (
    !Number.isInteger(input.askingPriceCents) ||
    input.askingPriceCents < MIN_ASKING_CENTS ||
    input.askingPriceCents > MAX_ASKING_CENTS
  ) {
    return { ok: false, reason: "INVALID_PRICE" };
  }
  const listing = await deps.db.listing.findUnique({ where: { id: input.listingId } });
  if (!listing || listing.sellerUserId !== input.sellerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (listing.format !== "FIXED" || (listing.status !== "LIVE" && listing.status !== "PENDING_REVIEW")) {
    return { ok: false, reason: "NOT_EDITABLE" };
  }
  if (listing.askingPriceCents === input.askingPriceCents) return { ok: false, reason: "UNCHANGED" };
  const active = await deps.db.order.count({ where: { listingId: listing.id, status: "CREATED" } });
  if (active > 0) return { ok: false, reason: "NOT_EDITABLE" };
  await deps.db.$transaction(async (tx) => {
    await tx.listing.update({ where: { id: listing.id }, data: { askingPriceCents: input.askingPriceCents } });
    await tx.listingPriceChange.create({
      data: {
        listingId: listing.id,
        oldAskingPriceCents: listing.askingPriceCents ?? input.askingPriceCents,
        newAskingPriceCents: input.askingPriceCents,
        changedAt: clock(deps),
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.sellerUserId,
      actorType: "USER",
      action: "listing.price_changed",
      subjectType: "Listing",
      subjectId: listing.id,
      before: { askingPriceCents: listing.askingPriceCents },
      after: { askingPriceCents: input.askingPriceCents },
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true };
}

export type WithdrawResult = { ok: true } | { ok: false; reason: "NOT_FOUND" | "NOT_WITHDRAWABLE" };

/** The seller takes a listing down. Text edits are made by withdrawing and submitting a new listing. */
export async function withdrawListing(
  deps: ManageDeps,
  input: { sellerUserId: string; listingId: string },
  ctx: RequestContext = {},
): Promise<WithdrawResult> {
  const listing = await deps.db.listing.findUnique({ where: { id: input.listingId } });
  if (!listing || listing.sellerUserId !== input.sellerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (listing.status !== "LIVE" && listing.status !== "PENDING_REVIEW") return { ok: false, reason: "NOT_WITHDRAWABLE" };
  const active = await deps.db.order.count({ where: { listingId: listing.id, status: { in: ["CREATED", "PAID_HELD"] } } });
  if (active > 0) return { ok: false, reason: "NOT_WITHDRAWABLE" };
  if (listing.format === "AUCTION") {
    const bids = await deps.db.bid.count({
      where: { auction: { listingId: listing.id, status: "LIVE" }, status: { in: ["ACTIVE", "WINNING", "OUTBID"] } },
    });
    if (bids > 0) return { ok: false, reason: "NOT_WITHDRAWABLE" };
  }
  await deps.db.$transaction(async (tx) => {
    await tx.listing.update({ where: { id: listing.id }, data: { status: "ENDED" } });
    await cancelOpenAuction(tx, listing.id, clock(deps));
    await tx.complianceReview.updateMany({
      where: { listingId: listing.id, status: "OPEN" },
      data: { status: "REJECTED", decision: "WITHDRAWN", notes: "Withdrawn by the seller", decidedAt: clock(deps) },
    });
    if (listing.status === "LIVE") {
      await recordListingOutcome(tx, { listingId: listing.id, outcome: "WITHDRAWN", closedAt: clock(deps) });
    }
    await writeAuditEvent(tx, {
      actorUserId: input.sellerUserId,
      actorType: "USER",
      action: "listing.withdrawn",
      subjectType: "Listing",
      subjectId: listing.id,
      before: { status: listing.status },
      after: { status: "ENDED" },
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true };
}

/** Daily view counter for the sales-outcome data; one upsert per page view. */
export async function recordListingView(db: Db, listingId: string, at: Date = new Date()) {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  await db.listingDailyStat.upsert({
    where: { listingId_date: { listingId, date } },
    create: { listingId, date, views: 1 },
    update: { views: { increment: 1 } },
  });
}
