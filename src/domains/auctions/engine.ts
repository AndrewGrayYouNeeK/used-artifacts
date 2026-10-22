import type { BidStatus, RetractionReason } from "@/generated/prisma/enums";

/**
 * Public bid increments (BUILD_PLAN 3.4), applied to buyer prices. Pure and
 * env-free so the listing page can show the same minimum bid the server enforces.
 */
export const INCREMENT_TABLE: readonly { belowCents: number; incrementCents: number }[] = [
  { belowCents: 1_000, incrementCents: 50 },
  { belowCents: 5_000, incrementCents: 100 },
  { belowCents: 10_000, incrementCents: 200 },
  { belowCents: 25_000, incrementCents: 500 },
  { belowCents: 50_000, incrementCents: 1_000 },
  { belowCents: 100_000, incrementCents: 2_500 },
  { belowCents: 250_000, incrementCents: 5_000 },
  { belowCents: 500_000, incrementCents: 10_000 },
  { belowCents: Number.POSITIVE_INFINITY, incrementCents: 25_000 },
];

export function bidIncrement(priceCents: number): number {
  return INCREMENT_TABLE.find((row) => priceCents < row.belowCents)!.incrementCents;
}

export const AUCTION_DURATIONS_DAYS = [3, 5, 7, 10] as const;

export interface EngineBid {
  id: string;
  bidderUserId: string;
  maxProxyCents: number;
  placedAt: Date;
  status: BidStatus;
}

export interface AuctionTerms {
  startingBidCents: number;
  reserveCents: number | null;
}

export interface RankedBidder {
  bidderUserId: string;
  bidId: string;
  maxCents: number;
  placedAt: Date;
}

export interface Standing {
  leader: RankedBidder | null;
  /** Null until the first bid; then the visible price. */
  priceCents: number | null;
  reserveMet: boolean;
  /** One entry per bidder (their best live bid), highest max first; ties go to the earlier bid. */
  ranking: RankedBidder[];
}

export const countsTowardPrice = (status: BidStatus) => status !== "RETRACTED" && status !== "VOIDED_SHILL";

/**
 * Proxy bidding, recomputed from every bidder's maximum so retractions and
 * voids can be replayed: the highest max leads, and the price is one
 * increment over the runner-up (never above the leader's max). When the
 * leader's max reaches a hidden reserve, the price jumps to the reserve.
 */
export function computeStanding(bids: readonly EngineBid[], terms: AuctionTerms): Standing {
  const best = new Map<string, RankedBidder>();
  for (const bid of bids) {
    if (!countsTowardPrice(bid.status)) continue;
    const prior = best.get(bid.bidderUserId);
    if (
      !prior ||
      bid.maxProxyCents > prior.maxCents ||
      (bid.maxProxyCents === prior.maxCents && bid.placedAt < prior.placedAt)
    ) {
      best.set(bid.bidderUserId, { bidderUserId: bid.bidderUserId, bidId: bid.id, maxCents: bid.maxProxyCents, placedAt: bid.placedAt });
    }
  }
  const ranking = [...best.values()].sort(
    (a, b) => b.maxCents - a.maxCents || a.placedAt.getTime() - b.placedAt.getTime() || a.bidId.localeCompare(b.bidId),
  );
  const leader = ranking[0] ?? null;
  if (!leader) return { leader: null, priceCents: null, reserveMet: false, ranking };

  const second = ranking[1];
  let price = second ? Math.min(leader.maxCents, second.maxCents + bidIncrement(second.maxCents)) : terms.startingBidCents;
  const reserveMet = terms.reserveCents === null || leader.maxCents >= terms.reserveCents;
  if (terms.reserveCents !== null && reserveMet) price = Math.max(price, terms.reserveCents);
  price = Math.max(price, terms.startingBidCents);
  return { leader, priceCents: price, reserveMet, ranking };
}

/** The lowest maximum a new bidder may enter. */
export function minimumBid(standing: Pick<Standing, "priceCents">, terms: AuctionTerms): number {
  return standing.priceCents === null ? terms.startingBidCents : standing.priceCents + bidIncrement(standing.priceCents);
}

export const FINAL_HOURS_MS = 12 * 60 * 60 * 1000;
export const SAME_MINUTE_MS = 60 * 1000;
export const TYPO_MULTIPLE = 10;

export type RetractionCheck =
  | { outcome: "AUTO_APPROVE" }
  | { outcome: "NEEDS_REVIEW" }
  | { outcome: "REFUSED"; reason: "FINAL_HOURS" | "NOT_A_TYPO" };

/**
 * Retraction limits (BUILD_PLAN 3.4): an obvious typo (at least 10x the
 * price before the bid) is approved on the spot; a materially changed
 * description or an unreachable seller goes to staff. Never in the final 12
 * hours, except a typo retracted within a minute of placing it.
 */
export function checkRetraction(input: {
  kind: RetractionReason;
  maxProxyCents: number;
  priceBeforeCents: number;
  placedAt: Date;
  endsAt: Date;
  now: Date;
}): RetractionCheck {
  const finalHours = input.endsAt.getTime() - input.now.getTime() < FINAL_HOURS_MS;
  const sameMinute = input.now.getTime() - input.placedAt.getTime() <= SAME_MINUTE_MS;
  const kind = input.kind;
  switch (kind) {
    case "TYPO": {
      if (input.maxProxyCents < TYPO_MULTIPLE * input.priceBeforeCents) return { outcome: "REFUSED", reason: "NOT_A_TYPO" };
      if (finalHours && !sameMinute) return { outcome: "REFUSED", reason: "FINAL_HOURS" };
      return { outcome: "AUTO_APPROVE" };
    }
    case "DESCRIPTION_CHANGED":
    case "SELLER_UNREACHABLE":
      return finalHours ? { outcome: "REFUSED", reason: "FINAL_HOURS" } : { outcome: "NEEDS_REVIEW" };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled retraction reason: ${String(exhaustive)}`);
    }
  }
}

export interface ShillFactors {
  /** A weak (non-blocking) link to the seller, such as a shared IP. */
  weakLinkToSeller: boolean;
  /** Bids the bidder placed in the lookback window, and how many were on this seller's auctions. */
  recentBids: number;
  recentBidsOnSeller: number;
  /** This seller's auctions the bidder bid on and how many they won. */
  sellerAuctionsBidOn: number;
  sellerAuctionsWon: number;
  /** Retractions in the lookback window. */
  recentRetractions: number;
}

export const SHILL_SIGNAL_SCORE = 50;
export const SHILL_VOID_SCORE = 80;

/**
 * Shill-bidding score (BUILD_PLAN 5.3) from linkage, concentration on one
 * seller, bidding prices up without winning, and retraction history.
 * 50+ opens a signal for staff; 80+ voids the bidder's bids on the auction.
 */
export function shillScore(f: ShillFactors): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (f.weakLinkToSeller) {
    score += 40;
    reasons.push("shares a network with the seller");
  }
  if (f.recentBids >= 5 && f.recentBidsOnSeller / f.recentBids >= 0.7) {
    score += 30;
    reasons.push(`${f.recentBidsOnSeller} of ${f.recentBids} recent bids are on this seller`);
  }
  if (f.sellerAuctionsBidOn >= 3 && f.sellerAuctionsWon === 0) {
    score += 20;
    reasons.push(`bid on ${f.sellerAuctionsBidOn} of this seller's auctions without winning`);
  }
  if (f.recentRetractions >= 2) {
    score += 10;
    reasons.push(`${f.recentRetractions} recent bid retractions`);
  }
  return { score: Math.min(100, score), reasons };
}
