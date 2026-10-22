import type { Db } from "@/lib/db";
import type { AuctionStatus } from "@/generated/prisma/enums";
import type { Tx } from "@/domains/audit/audit";
import { DAY_MS } from "@/domains/orders/deps";

/** Statuses in which the auction is the listing's current one (the partial unique index excludes RELISTED and CANCELLED). */
export const OPEN_AUCTION_STATUSES = ["SCHEDULED", "LIVE", "ENDED", "AWAITING_SELLER"] as const satisfies AuctionStatus[];

/** Approval puts the listing's scheduled auction live; the clock starts now. */
export async function startScheduledAuction(tx: Tx, listingId: string, now: Date) {
  const auction = await tx.auction.findFirst({ where: { listingId, status: "SCHEDULED" } });
  if (!auction) throw new Error(`Auction listing ${listingId} has no scheduled auction`);
  const endsAt = new Date(now.getTime() + auction.durationDays * DAY_MS);
  await tx.auction.update({
    where: { id: auction.id },
    data: { status: "LIVE", startsAt: now, endsAt, originalEndsAt: endsAt },
  });
  return { auctionId: auction.id, endsAt };
}

/** Ends the listing's auction when the listing is rejected, withdrawn, or removed. Bids stay on record. */
export async function cancelOpenAuction(tx: Tx, listingId: string, now: Date) {
  const cancelled = await tx.auction.updateMany({
    where: { listingId, status: { in: ["SCHEDULED", "LIVE", "AWAITING_SELLER"] } },
    data: { status: "CANCELLED", closedAt: now },
  });
  return cancelled.count;
}

/** The listing's newest auction, whatever its status. */
export function latestAuction(db: Db | Tx, listingId: string) {
  return db.auction.findFirst({ where: { listingId }, orderBy: { createdAt: "desc" } });
}
