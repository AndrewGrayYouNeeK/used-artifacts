import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCategory,
  createVerifiedUser,
  ensureProvenanceTemplate,
  markIdentityVerified,
  testDb,
  testPhotos,
} from "../../../test/helpers";
import { economics } from "@/config/economics";
import { platform, type PlatformConfig } from "@/config/platform";
import { PROVENANCE_TEMPLATE_V2 } from "@/domains/compliance/provenance-template";
import { decideListingReview } from "@/domains/compliance/review";
import { FakeVisionProvider } from "@/domains/ai/fake-vision";
import { submitListing } from "@/domains/listings/listings";
import { withdrawListing } from "@/domains/listings/manage";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { upsertLink } from "@/domains/trust/linkage";
import { MemoryMailer } from "@/lib/email/mailer";
import {
  decideAfterNonPayment,
  decideRetraction,
  payAuctionOrder,
  placeBid,
  requestRetraction,
  runAuctionJobs,
  voidBids,
  type AuctionDeps,
} from "./auctions";
import { computeStanding } from "./engine";

const db = testDb();
afterAll(() => db.$disconnect());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ON: PlatformConfig = { ...platform, auctionsEnabled: true };
const address = { name: "Bea Bidder", line1: "1 Main St", city: "Louisville", state: "KY", postalCode: "40202", country: "US" };

function makeDeps(clock: { now: number }, config: PlatformConfig = ON): AuctionDeps & { payments: FakePaymentsProvider; mailer: MemoryMailer } {
  return {
    db,
    payments: new FakePaymentsProvider("http://test.local"),
    appUrl: "http://test.local",
    linkageSecret: "x".repeat(32),
    platform: config,
    mailer: new MemoryMailer(),
    now: () => new Date(clock.now),
  };
}

async function verifiedBidder() {
  const user = await createVerifiedUser(db);
  await markIdentityVerified(db, user.id);
  return user;
}

/** Submits and approves an auction listing; amounts are the seller's asking terms (bidders see +10%). */
async function liveAuction(clock: { now: number }, opts: { startingBid?: number; reservePrice?: number; durationDays?: number } = {}) {
  await ensureProvenanceTemplate(db);
  const seller = await verifiedBidder();
  await db.storefront.create({
    data: {
      name: "Auction Store",
      slug: `auction-${randomUUID().slice(0, 8)}`,
      ownerUserId: seller.id,
      stripeAccountId: `fake_acct_${randomUUID()}`,
      payoutsEnabled: true,
      members: { create: { userId: seller.id, role: "OWNER" } },
    },
  });
  const category = await createCategory(db);
  const submitted = await submitListing(
    { db, vision: new FakeVisionProvider(), platform: ON, now: () => new Date(clock.now) },
    {
      userId: seller.id,
      photos: testPhotos(),
      submission: {
        categoryId: category.id,
        title: "Adena stemmed point",
        description: "Kentucky hornstone Adena point, about 3 inches, no repairs.",
        format: "AUCTION",
        startingBid: opts.startingBid ?? 1_000,
        reservePrice: opts.reservePrice,
        durationDays: opts.durationDays ?? 7,
        shipping: 500,
        acquisitionSource: "PURCHASED",
        acquisitionDetails: "Bought from a dealer's estate collection in Louisville in 2004.",
        attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
        iacaAcknowledged: false,
        signedName: "Jane Q Seller",
      },
    },
  );
  if (!submitted.ok) throw new Error(JSON.stringify(submitted));
  const reviewer = await createVerifiedUser(db, { role: "MODERATOR" });
  const approved = await decideListingReview(
    { db, platform: ON, now: () => new Date(clock.now) },
    { reviewerId: reviewer.id, reviewId: submitted.reviewId, decision: "APPROVE", notes: "" },
  );
  if (!approved.ok) throw new Error(JSON.stringify(approved));
  const auction = await db.auction.findFirstOrThrow({ where: { listingId: submitted.listingId } });
  return { seller, listingId: submitted.listingId, auction, reviewer };
}

async function bid(deps: AuctionDeps, auctionId: string, bidderUserId: string, maxCents: number) {
  return placeBid(deps, { auctionId, bidderUserId, maxCents });
}

describe("auctions behind the flag", () => {
  it("refuses auction listings, bids, and jobs while AUCTIONS_ENABLED is off", async () => {
    const clock = { now: Date.now() };
    const off = makeDeps(clock, { ...platform, auctionsEnabled: false });
    const seller = await verifiedBidder();
    const category = await createCategory(db);
    const result = await submitListing(
      { db, vision: new FakeVisionProvider(), platform: off.platform },
      {
        userId: seller.id,
        photos: testPhotos(),
        submission: {
          categoryId: category.id,
          title: "Adena stemmed point",
          description: "Kentucky hornstone Adena point, about 3 inches, no repairs.",
          format: "AUCTION",
          startingBid: 1_000,
          durationDays: 7,
          shipping: 0,
          acquisitionSource: "PURCHASED",
          acquisitionDetails: "Bought from a dealer's estate collection in Louisville in 2004.",
          attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
          iacaAcknowledged: false,
          signedName: "Jane Q Seller",
        },
      },
    );
    expect(result).toEqual({ ok: false, reason: "AUCTIONS_DISABLED" });

    const { auction } = await liveAuction(clock);
    const bidder = await verifiedBidder();
    expect(await bid(off, auction.id, bidder.id, 5_000)).toEqual({ ok: false, reason: "AUCTIONS_DISABLED" });
    expect(await runAuctionJobs(off)).toMatchObject({ enabled: false, sold: 0 });
    expect(platform.auctionsEnabled).toBe(false);
  });
});

describe("bidding", () => {
  it("goes live on approval and runs proxy bids in buyer-price terms", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { seller, auction } = await liveAuction(clock, { startingBid: 1_000 });
    expect(auction).toMatchObject({ status: "LIVE", startingBidCents: 1_100, isNoReserve: true, softCloseMinutes: 2 });
    expect(auction.endsAt!.getTime()).toBe(clock.now + 7 * DAY);

    const [a, b, c] = [await verifiedBidder(), await verifiedBidder(), await verifiedBidder()];
    expect(await bid(deps, auction.id, seller.id, 5_000)).toEqual({ ok: false, reason: "OWN_LISTING" });
    expect(await bid(deps, auction.id, a.id, 1_000)).toEqual({ ok: false, reason: "BID_TOO_LOW", minimumCents: 1_100 });
    expect(await bid(deps, auction.id, a.id, 5_000)).toMatchObject({ ok: true, leading: true, priceCents: 1_100 });
    clock.now += 1_000;
    expect(await bid(deps, auction.id, b.id, 3_000)).toMatchObject({ ok: true, leading: false, priceCents: 3_100 });
    clock.now += 1_000;
    expect(await bid(deps, auction.id, c.id, 6_000)).toMatchObject({ ok: true, leading: true, priceCents: 5_200 });
    expect(await bid(deps, auction.id, b.id, 5_300)).toEqual({ ok: false, reason: "BID_TOO_LOW", minimumCents: 5_400 });

    const stored = await db.auction.findUniqueOrThrow({ where: { id: auction.id }, include: { currentHighBid: true } });
    expect(stored).toMatchObject({ currentPriceCents: 5_200, bidCount: 3, currentHighBid: { bidderUserId: c.id } });
    expect(deps.mailer.sent.map((m) => m.to)).toEqual([a.email]);
    expect(deps.mailer.sent[0].text).toContain("$52.00");
    expect(deps.mailer.sent[0].text).not.toContain("$60.00");

    const unverified = await createVerifiedUser(db);
    expect(await bid(deps, auction.id, unverified.id, 9_000)).toEqual({ ok: false, reason: "NOT_VERIFIED" });

    const first = await db.bid.findFirstOrThrow({ where: { auctionId: auction.id, bidderUserId: a.id } });
    await expect(db.bid.update({ where: { id: first.id }, data: { maxProxyCents: 1 } })).rejects.toThrow(/immutable/);
    await expect(db.bid.delete({ where: { id: first.id } })).rejects.toThrow(/never deleted/);
    await expect(db.auction.update({ where: { id: auction.id }, data: { status: "SETTLED" } })).rejects.toThrow(/Illegal auction status/);
  });

  it("extends the end time for a bid inside the soft-close window", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { auction } = await liveAuction(clock, { durationDays: 3 });
    const bidder = await verifiedBidder();
    clock.now = auction.endsAt!.getTime() - 30_000;
    const placed = await bid(deps, auction.id, bidder.id, 2_000);
    expect(placed).toMatchObject({ ok: true });
    if (!placed.ok) return;
    expect(placed.endsAt.getTime()).toBe(clock.now + 2 * 60_000);
    expect((await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).originalEndsAt).toEqual(auction.endsAt);
  });

  it("blocks a bidder strongly linked to the seller and flags shill patterns", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { seller, auction } = await liveAuction(clock);
    const sockPuppet = await verifiedBidder();
    await db.$transaction((tx) => upsertLink(tx, sockPuppet.id, seller.id, "SAME_DEVICE"));
    expect(await bid(deps, auction.id, sockPuppet.id, 5_000)).toEqual({ ok: false, reason: "SELF_DEALING" });

    const neighbour = await verifiedBidder();
    await db.$transaction((tx) => upsertLink(tx, neighbour.id, seller.id, "SAME_IP"));
    const honest = await verifiedBidder();
    expect(await bid(deps, auction.id, honest.id, 20_000)).toMatchObject({ ok: true, leading: true });
    for (let i = 0; i < 5; i++) {
      clock.now += 1_000;
      const r = await bid(deps, auction.id, neighbour.id, 2_000 + i * 1_000);
      expect(r).toMatchObject({ ok: true, leading: false });
    }
    const signal = await db.fraudSignal.findFirstOrThrow({ where: { detector: "SHILL", subjectId: neighbour.id, status: "OPEN" } });
    expect(signal.score).toBe(70);
    expect(signal.evidence).toMatchObject({ auctionId: auction.id, sellerUserId: seller.id });
    const priceBefore = (await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).currentPriceCents!;
    expect(priceBefore).toBeGreaterThan(5_000);

    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    const voided = await voidBids(deps, {
      staffUserId: staff.id,
      auctionId: auction.id,
      bidderUserId: neighbour.id,
      reason: "Shill bidding for the seller",
      fraudSignalId: signal.id,
    });
    expect(voided).toMatchObject({ ok: true, voided: 5 });
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ currentPriceCents: 1_100, bidCount: 1 });
    expect(await db.enforcementAction.findFirstOrThrow({ where: { userId: neighbour.id } })).toMatchObject({ type: "BID_VOID", actorId: staff.id });
    expect(await db.fraudSignal.findUniqueOrThrow({ where: { id: signal.id } })).toMatchObject({ status: "CONFIRMED" });
  });
});

describe("closing and payment", () => {
  it("creates the winner's order at the closing price, then settles on payment", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { listingId, auction } = await liveAuction(clock);
    const [a, b] = [await verifiedBidder(), await verifiedBidder()];
    await bid(deps, auction.id, a.id, 5_000);
    clock.now += 1_000;
    await bid(deps, auction.id, b.id, 5_100);
    clock.now = auction.endsAt!.getTime() + 1;
    expect((await runAuctionJobs(deps)).sold).toBeGreaterThanOrEqual(1);

    const closed = await db.auction.findUniqueOrThrow({ where: { id: auction.id }, include: { order: true } });
    expect(closed).toMatchObject({ status: "ENDED", winnerUserId: b.id });
    const order = closed.order!;
    expect(order).toMatchObject({
      source: "AUCTION",
      status: "CREATED",
      buyerPriceCents: 5_100,
      askingPriceCents: 4_636,
      buyerFeeCents: 464,
      sellerFeeCents: 464,
      sellerPayoutCents: 4_172,
      shippingCents: 500,
    });
    expect(order.paymentDueAt!.getTime()).toBe(clock.now + economics.auctionPaymentWindowHours * HOUR);
    expect(deps.mailer.sent.some((m) => m.to === b.email && m.subject.startsWith("You won"))).toBe(true);

    expect(await payAuctionOrder(deps, { buyerUserId: a.id, buyerEmail: a.email, orderId: order.id })).toEqual({ ok: false, reason: "NOT_FOUND" });
    const pay = await payAuctionOrder(deps, { buyerUserId: b.id, buyerEmail: b.email, orderId: order.id });
    expect(pay).toMatchObject({ ok: true });
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id, status: "REQUIRES_PAYMENT" } });
    expect(payment.amountCents).toBe(5_600);
    await processPaymentEvent(
      deps,
      fakeCheckoutCompleted({ checkoutSessionId: payment.checkoutSessionId, amountCents: 5_600, taxCents: 0, shippingAddress: address, paymentFingerprint: `card_${randomUUID()}` }),
    );
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID_HELD" });
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ status: "SETTLED" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listingId } })).toMatchObject({ status: "SOLD" });
  });

  it("ends unsold when the reserve isn't met", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { listingId, auction } = await liveAuction(clock, { startingBid: 1_000, reservePrice: 10_000 });
    expect(auction).toMatchObject({ reserveCents: 11_000, isNoReserve: false });
    const a = await verifiedBidder();
    expect(await bid(deps, auction.id, a.id, 9_000)).toMatchObject({ ok: true, reserveMet: false, priceCents: 1_100 });
    clock.now = auction.endsAt!.getTime() + 1;
    expect((await runAuctionJobs(deps)).unsold).toBeGreaterThanOrEqual(1);
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ status: "UNSOLD", winnerUserId: null });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listingId } })).toMatchObject({ status: "ENDED" });
    expect(await db.listingOutcome.findUniqueOrThrow({ where: { listingId } })).toMatchObject({ outcome: "UNSOLD_AUCTION" });
  });

  it("records a strike when the winner doesn't pay, then offers a second chance or relists", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { seller, listingId, auction } = await liveAuction(clock);
    const [deadbeat, runnerUp] = [await verifiedBidder(), await verifiedBidder()];
    await bid(deps, auction.id, runnerUp.id, 3_000);
    clock.now += 1_000;
    await bid(deps, auction.id, deadbeat.id, 8_000);
    clock.now = auction.endsAt!.getTime() + 1;
    await runAuctionJobs(deps);

    clock.now += economics.auctionPaymentWindowHours * HOUR + 1;
    await runEscrowJobs(deps);
    expect((await runAuctionJobs(deps)).nonPayments).toBeGreaterThanOrEqual(1);
    const awaiting = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(awaiting.status).toBe("AWAITING_SELLER");
    expect(await db.nonPayingBidderStrike.count({ where: { userId: deadbeat.id } })).toBe(1);

    const offer = await decideAfterNonPayment(deps, { sellerUserId: seller.id, auctionId: auction.id, decision: "SECOND_CHANCE" });
    expect(offer).toMatchObject({ ok: true, decision: "SECOND_CHANCE", buyerUserId: runnerUp.id });
    if (!offer.ok || offer.decision !== "SECOND_CHANCE") return;
    expect(await db.order.findUniqueOrThrow({ where: { id: offer.orderId } })).toMatchObject({ source: "SECOND_CHANCE", buyerPriceCents: 3_000 });

    clock.now += economics.auctionPaymentWindowHours * HOUR + 1;
    await runEscrowJobs(deps);
    await runAuctionJobs(deps);
    expect(await decideAfterNonPayment(deps, { sellerUserId: seller.id, auctionId: auction.id, decision: "SECOND_CHANCE" })).toEqual({
      ok: false,
      reason: "NO_SECOND_BIDDER",
    });
    clock.now += ON.auctionSellerDecisionDays * DAY + 1;
    expect((await runAuctionJobs(deps)).relisted).toBeGreaterThanOrEqual(1);
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ status: "RELISTED" });
    const relisted = await db.auction.findFirstOrThrow({ where: { listingId, status: "LIVE" } });
    expect(relisted).toMatchObject({ relistOfId: auction.id, bidCount: 0, startingBidCents: 1_100 });

    await db.nonPayingBidderStrike.create({ data: { userId: deadbeat.id, auctionId: auction.id, orderId: `manual-${randomUUID()}` } });
    expect(await bid(deps, relisted.id, deadbeat.id, 5_000)).toEqual({ ok: false, reason: "BIDDING_RESTRICTED" });
  });
});

describe("retractions and withdrawal", () => {
  it("approves an obvious typo once per 90 days and sends other reasons to staff", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { seller, auction } = await liveAuction(clock);
    const [a, b] = [await verifiedBidder(), await verifiedBidder()];
    await bid(deps, auction.id, a.id, 2_000);
    clock.now += 1_000;
    const typo = await bid(deps, auction.id, b.id, 300_000);
    expect(typo).toMatchObject({ ok: true, leading: true });
    if (!typo.ok) return;
    expect(await requestRetraction(deps, { bidderUserId: b.id, bidId: typo.bidId, kind: "TYPO", reason: "Meant to type 30.00" })).toEqual({ ok: true, status: "APPROVED" });
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ currentPriceCents: 1_100, bidCount: 1 });

    clock.now += 1_000;
    const again = await bid(deps, auction.id, b.id, 3_000);
    if (!again.ok) throw new Error(again.reason);
    expect(await requestRetraction(deps, { bidderUserId: b.id, bidId: again.bidId, kind: "DESCRIPTION_CHANGED", reason: "The photos changed after I bid" })).toEqual({
      ok: false,
      reason: "QUOTA_EXCEEDED",
    });

    const aBid = await db.bid.findFirstOrThrow({ where: { auctionId: auction.id, bidderUserId: a.id } });
    expect(await requestRetraction(deps, { bidderUserId: a.id, bidId: aBid.id, kind: "TYPO", reason: "This was not really a typo" })).toEqual({ ok: false, reason: "NOT_A_TYPO" });
    expect(await requestRetraction(deps, { bidderUserId: a.id, bidId: aBid.id, kind: "SELLER_UNREACHABLE", reason: "Seller never answers questions" })).toEqual({
      ok: true,
      status: "PENDING",
    });
    const request = await db.bidRetraction.findUniqueOrThrow({ where: { bidId: aBid.id } });
    expect(await decideRetraction(deps, { staffUserId: seller.id, retractionId: request.id, approve: true, notes: "approve my own" })).toEqual({ ok: false, reason: "NOT_STAFF" });
    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(await decideRetraction(deps, { staffUserId: staff.id, retractionId: request.id, approve: true, notes: "Seller unresponsive for 5 days" })).toEqual({ ok: true });
    expect(await db.bid.findUniqueOrThrow({ where: { id: aBid.id } })).toMatchObject({ status: "RETRACTED" });
    expect(await db.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ currentPriceCents: 1_100, bidCount: 1 });
    await expect(db.bidRetraction.update({ where: { id: request.id }, data: { status: "DENIED" } })).rejects.toThrow(/final/);

    clock.now = auction.endsAt!.getTime() - HOUR;
    const late = await bid(deps, auction.id, a.id, 50_000);
    if (!late.ok) throw new Error(late.reason);
    clock.now += 2 * 60_000;
    const other = await verifiedBidder();
    const lateTypo = await bid(deps, auction.id, other.id, 900_000);
    if (!lateTypo.ok) throw new Error(lateTypo.reason);
    clock.now += 2 * 60_000;
    expect(await requestRetraction(deps, { bidderUserId: other.id, bidId: lateTypo.bidId, kind: "TYPO", reason: "Fat-fingered an extra zero" })).toEqual({
      ok: false,
      reason: "FINAL_HOURS",
    });
  });

  it("lets the seller withdraw only before the first bid", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const first = await liveAuction(clock);
    expect(await withdrawListing({ db }, { sellerUserId: first.seller.id, listingId: first.listingId })).toEqual({ ok: true });
    expect(await db.auction.findUniqueOrThrow({ where: { id: first.auction.id } })).toMatchObject({ status: "CANCELLED" });

    const second = await liveAuction(clock);
    await bid(deps, second.auction.id, (await verifiedBidder()).id, 2_000);
    expect(await withdrawListing({ db }, { sellerUserId: second.seller.id, listingId: second.listingId })).toEqual({ ok: false, reason: "NOT_WITHDRAWABLE" });
  });
});

describe("auction load", () => {
  it("keeps one consistent standing under a burst of concurrent bids", async () => {
    const clock = { now: Date.now() };
    const deps = makeDeps(clock);
    const { auction } = await liveAuction(clock, { startingBid: 1_000 });
    const bidders = await Promise.all(Array.from({ length: 30 }, () => verifiedBidder()));
    const maxes = bidders.flatMap((b, i) => [1, 2, 3].map((round) => ({ bidder: b, maxCents: auction.startingBidCents + 100 * (i * 3 + round) * 7 })));
    for (let i = maxes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [maxes[i], maxes[j]] = [maxes[j], maxes[i]];
    }

    const started = performance.now();
    const results = await Promise.allSettled(maxes.map((m) => bid(deps, auction.id, m.bidder.id, m.maxCents)));
    const elapsedMs = performance.now() - started;

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof bid>>>).value);
    for (const o of outcomes) if (!o.ok) expect(o.reason).toBe("BID_TOO_LOW");
    const accepted = outcomes.filter((o) => o.ok);
    expect(accepted.length).toBeGreaterThan(0);

    const after = await db.auction.findUniqueOrThrow({ where: { id: auction.id } });
    const bids = await db.bid.findMany({ where: { auctionId: auction.id } });
    expect(bids).toHaveLength(accepted.length);
    expect(after.bidCount).toBe(bids.length);
    const standing = computeStanding(bids, after);
    const top = Math.max(...maxes.map((m) => m.maxCents));
    expect(standing.leader?.maxCents).toBe(top);
    expect(after.currentHighBidId).toBe(standing.leader?.bidId);
    expect(after.currentPriceCents).toBe(standing.priceCents);
    for (const b of bids) expect(b.amountCents).toBeGreaterThanOrEqual(b.priceBeforeCents);
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
