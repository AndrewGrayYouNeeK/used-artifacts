import { describe, expect, it } from "vitest";
import { bidIncrement, checkRetraction, computeStanding, minimumBid, shillScore, type EngineBid } from "./engine";

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s));
const bid = (id: string, bidder: string, max: number, at: number, status: EngineBid["status"] = "ACTIVE"): EngineBid => ({
  id,
  bidderUserId: bidder,
  maxProxyCents: max,
  placedAt: t(at),
  status,
});
const open = { startingBidCents: 1_000, reserveCents: null };

describe("bid increments", () => {
  it("follows the public table", () => {
    expect(bidIncrement(999)).toBe(50);
    expect(bidIncrement(1_000)).toBe(100);
    expect(bidIncrement(9_999)).toBe(200);
    expect(bidIncrement(10_000)).toBe(500);
    expect(bidIncrement(99_999)).toBe(2_500);
    expect(bidIncrement(500_000)).toBe(25_000);
  });
});

describe("proxy bidding", () => {
  it("opens at the starting bid with one bidder", () => {
    const s = computeStanding([bid("a", "A", 5_000, 1)], open);
    expect(s).toMatchObject({ priceCents: 1_000, reserveMet: true, leader: { bidderUserId: "A" } });
    expect(minimumBid(s, open)).toBe(1_100);
  });

  it("prices one increment over the runner-up, capped at the leader's max", () => {
    expect(computeStanding([bid("a", "A", 5_000, 1), bid("b", "B", 3_000, 2)], open)).toMatchObject({ priceCents: 3_100, leader: { bidderUserId: "A" } });
    expect(computeStanding([bid("a", "A", 5_000, 1), bid("b", "B", 4_950, 2)], open)).toMatchObject({ priceCents: 5_000 });
  });

  it("breaks ties in favour of the earlier bid", () => {
    const s = computeStanding([bid("b", "B", 5_000, 2), bid("a", "A", 5_000, 1)], open);
    expect(s).toMatchObject({ priceCents: 5_000, leader: { bidderUserId: "A" } });
  });

  it("uses each bidder's highest live max and ignores retracted or voided bids", () => {
    const bids = [bid("a1", "A", 2_000, 1), bid("a2", "A", 9_000, 3, "RETRACTED"), bid("b", "B", 4_000, 2), bid("c", "C", 8_000, 4, "VOIDED_SHILL")];
    expect(computeStanding(bids, open)).toMatchObject({ priceCents: 2_100, leader: { bidderUserId: "B" } });
    expect(computeStanding([bid("x", "X", 1_000, 1, "RETRACTED")], open)).toMatchObject({ leader: null, priceCents: null });
  });

  it("jumps to a hidden reserve once a max reaches it", () => {
    const terms = { startingBidCents: 1_000, reserveCents: 10_000 };
    expect(computeStanding([bid("a", "A", 9_999, 1)], terms)).toMatchObject({ priceCents: 1_000, reserveMet: false });
    expect(computeStanding([bid("a", "A", 12_000, 1)], terms)).toMatchObject({ priceCents: 10_000, reserveMet: true });
    expect(computeStanding([bid("a", "A", 12_000, 1), bid("b", "B", 11_000, 2)], terms)).toMatchObject({ priceCents: 11_500 });
  });
});

describe("retraction limits", () => {
  const endsAt = new Date(Date.UTC(2026, 0, 10));
  const base = { maxProxyCents: 100_000, priceBeforeCents: 5_000, placedAt: new Date(Date.UTC(2026, 0, 5)), endsAt };

  it("approves an obvious typo on the spot and refuses one that isn't", () => {
    expect(checkRetraction({ ...base, kind: "TYPO", now: new Date(Date.UTC(2026, 0, 6)) })).toEqual({ outcome: "AUTO_APPROVE" });
    expect(checkRetraction({ ...base, kind: "TYPO", maxProxyCents: 49_999, now: new Date(Date.UTC(2026, 0, 6)) })).toEqual({
      outcome: "REFUSED",
      reason: "NOT_A_TYPO",
    });
  });

  it("sends other reasons to staff, but nothing in the final 12 hours except a same-minute typo", () => {
    const early = new Date(Date.UTC(2026, 0, 6));
    expect(checkRetraction({ ...base, kind: "DESCRIPTION_CHANGED", now: early })).toEqual({ outcome: "NEEDS_REVIEW" });
    const late = new Date(endsAt.getTime() - 60 * 60 * 1000);
    expect(checkRetraction({ ...base, kind: "SELLER_UNREACHABLE", now: late })).toEqual({ outcome: "REFUSED", reason: "FINAL_HOURS" });
    expect(checkRetraction({ ...base, kind: "TYPO", now: late })).toEqual({ outcome: "REFUSED", reason: "FINAL_HOURS" });
    expect(checkRetraction({ ...base, kind: "TYPO", placedAt: new Date(late.getTime() - 30_000), now: late })).toEqual({ outcome: "AUTO_APPROVE" });
  });
});

describe("shill score", () => {
  const clean = { weakLinkToSeller: false, recentBids: 2, recentBidsOnSeller: 1, sellerAuctionsBidOn: 0, sellerAuctionsWon: 0, recentRetractions: 0 };

  it("stays quiet for ordinary bidding", () => {
    expect(shillScore(clean).score).toBe(0);
  });

  it("adds linkage, concentration, never-winning, and retractions", () => {
    expect(shillScore({ ...clean, weakLinkToSeller: true, recentBids: 6, recentBidsOnSeller: 5 }).score).toBe(70);
    const all = shillScore({ weakLinkToSeller: true, recentBids: 10, recentBidsOnSeller: 9, sellerAuctionsBidOn: 4, sellerAuctionsWon: 0, recentRetractions: 2 });
    expect(all.score).toBe(100);
    expect(all.reasons).toHaveLength(4);
  });
});
