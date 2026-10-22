import type { Auction, Listing, Order } from "@/generated/prisma/client";
import type { OrderSource, RetractionReason } from "@/generated/prisma/enums";
import { feeRates } from "@/config/economics";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { checkIdentityGate, type IdentityGate } from "@/domains/identity/verification/verification";
import { recordListingOutcome } from "@/domains/listings/outcomes";
import { openCheckoutSession } from "@/domains/orders/checkout";
import { clock, DAY_MS, econ, platformConfig, type OrdersDeps } from "@/domains/orders/deps";
import { formatUsd, splitBuyerPrice } from "@/domains/pricing/pricing";
import { checkSelfDealing, linkByDevice, raiseFraudSignal, STRONG_SIGNALS } from "@/domains/trust/linkage";
import type { EmailMessage, Mailer } from "@/lib/email/mailer";
import {
  checkRetraction,
  computeStanding,
  countsTowardPrice,
  minimumBid,
  shillScore,
  SHILL_SIGNAL_SCORE,
  SHILL_VOID_SCORE,
  type Standing,
} from "./engine";
import { isPaused } from "@/domains/admin/kill-switches";

export interface AuctionDeps extends OrdersDeps {
  /** Outbid, win, and non-payment notices; sent after commit. */
  mailer?: Mailer;
}

/** Two unpaid wins within a year blocks bidding until staff review. */
export const NONPAY_STRIKE_LIMIT = 2;
export const NONPAY_LOOKBACK_DAYS = 365;
export const RETRACTION_QUOTA = 1;
export const RETRACTION_QUOTA_DAYS = 90;
export const SHILL_LOOKBACK_DAYS = 90;
/** Bids are capped at the largest buyer price a fixed-price listing can have. */
export const MAX_BID_CENTS = 110_000_000;
/** Stripe Checkout sessions must expire between 30 minutes and 24 hours out. */
const CHECKOUT_MIN_MS = 30 * 60 * 1000;
const CHECKOUT_MAX_MS = 23 * 60 * 60 * 1000;

type GateFailure = Extract<IdentityGate, { ok: false }>["reason"];

const STAFF_ROLES = new Set(["OWNER", "MODERATOR"]);

async function lockAuction(tx: Tx, auctionId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Auction" WHERE "id" = ${auctionId} FOR UPDATE`;
  return tx.auction.findUnique({
    where: { id: auctionId },
    include: { listing: { select: { id: true, title: true, sellerUserId: true, storefrontId: true, shippingCents: true, status: true } } },
  });
}

type LockedAuction = NonNullable<Awaited<ReturnType<typeof lockAuction>>>;

/** Replays every live bid and stores the result: leader, visible price, reserve met, bid statuses. */
async function refreshStanding(tx: Tx, auction: Pick<Auction, "id" | "startingBidCents" | "reserveCents">): Promise<Standing> {
  const bids = await tx.bid.findMany({
    where: { auctionId: auction.id },
    select: { id: true, bidderUserId: true, maxProxyCents: true, placedAt: true, status: true },
  });
  const standing = computeStanding(bids, auction);
  const leaderBidId = standing.leader?.bidId ?? null;
  await tx.bid.updateMany({
    where: { auctionId: auction.id, status: { in: ["ACTIVE", "WINNING"] }, ...(leaderBidId ? { id: { not: leaderBidId } } : {}) },
    data: { status: "OUTBID" },
  });
  if (leaderBidId) await tx.bid.update({ where: { id: leaderBidId }, data: { status: "WINNING" } });
  await tx.auction.update({
    where: { id: auction.id },
    data: {
      currentPriceCents: standing.priceCents,
      currentHighBidId: leaderBidId,
      reserveMet: standing.reserveMet,
      bidCount: bids.filter((b) => countsTowardPrice(b.status)).length,
    },
  });
  return standing;
}

async function notify(deps: AuctionDeps, messages: EmailMessage[]) {
  if (!deps.mailer) return;
  for (const m of messages) {
    await deps.mailer.send(m).catch((err) => console.error("[auctions] email failed", err));
  }
}

async function emailOf(tx: Tx, userId: string) {
  return (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;
}

async function activeStrikes(db: Tx | OrdersDeps["db"], userId: string, now: Date) {
  return db.nonPayingBidderStrike.count({
    where: { userId, createdAt: { gte: new Date(now.getTime() - NONPAY_LOOKBACK_DAYS * DAY_MS) } },
  });
}

// ───────────── Bidding ─────────────

export type PlaceBidResult =
  | { ok: true; bidId: string; leading: boolean; priceCents: number; endsAt: Date; reserveMet: boolean; voided: boolean }
  | { ok: false; reason: GateFailure | "AUCTION_CLOSED" | "OWN_LISTING" | "SELF_DEALING" | "ACCOUNT_RESTRICTED" | "BIDDING_RESTRICTED" | "BIDDING_PAUSED" }
  | { ok: false; reason: "BID_TOO_LOW"; minimumCents: number }
  | { ok: false; reason: "BID_TOO_HIGH"; maximumCents: number };

/**
 * Places a proxy bid (BUILD_PLAN 3.4). Runs with the auction row locked so
 * bids apply one at a time: validate, insert, extend a soft close, replay
 * the standing, then score the bidder for shill patterns.
 */
export async function placeBid(
  deps: AuctionDeps,
  input: { auctionId: string; bidderUserId: string; maxCents: number },
  ctx: RequestContext = {},
): Promise<PlaceBidResult> {
  const now = clock(deps);
  const config = platformConfig(deps);
  const gate = await checkIdentityGate(deps.db, input.bidderUserId, "BID", config);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (await isPaused(deps.db, "BIDDING")) return { ok: false, reason: "BIDDING_PAUSED" };
  if (!Number.isInteger(input.maxCents) || input.maxCents <= 0) return { ok: false, reason: "BID_TOO_LOW", minimumCents: 1 };
  if (input.maxCents > MAX_BID_CENTS) return { ok: false, reason: "BID_TOO_HIGH", maximumCents: MAX_BID_CENTS };

  const bidder = await deps.db.user.findUnique({ where: { id: input.bidderUserId }, select: { status: true } });
  if (!bidder || bidder.status !== "ACTIVE") return { ok: false, reason: "ACCOUNT_RESTRICTED" };
  if ((await activeStrikes(deps.db, input.bidderUserId, now)) >= NONPAY_STRIKE_LIMIT) return { ok: false, reason: "BIDDING_RESTRICTED" };

  const auction = await deps.db.auction.findUnique({ where: { id: input.auctionId }, include: { listing: true } });
  if (!auction || auction.status !== "LIVE") return { ok: false, reason: "AUCTION_CLOSED" };
  if (ctx.deviceIdHash) {
    const device = ctx.deviceIdHash;
    await deps.db.$transaction((tx) => linkByDevice(tx, input.bidderUserId, device));
  }
  const selfDeal = await checkSelfDealing(deps.db, {
    buyerUserId: input.bidderUserId,
    sellerUserId: auction.listing.sellerUserId,
    storefrontId: auction.listing.storefrontId,
  });
  if (!selfDeal.ok) {
    switch (selfDeal.reason) {
      case "OWN_LISTING":
      case "STOREFRONT_MEMBER":
        return { ok: false, reason: "OWN_LISTING" };
      case "LINKED_ACCOUNT":
        await deps.db.$transaction(async (tx) => {
          await raiseFraudSignal(tx, {
            detector: "SHILL",
            subjectType: "User",
            subjectId: input.bidderUserId,
            score: 85,
            evidence: { auctionId: auction.id, sellerUserId: auction.listing.sellerUserId, blocked: true, signals: selfDeal.signals },
          });
          await writeAuditEvent(tx, {
            actorUserId: input.bidderUserId,
            actorType: "USER",
            action: "auction.self_bid_blocked",
            subjectType: "Auction",
            subjectId: auction.id,
            after: { sellerUserId: auction.listing.sellerUserId, signals: selfDeal.signals },
            ipHash: ctx.ipHash,
          });
        });
        return { ok: false, reason: "SELF_DEALING" };
      default: {
        const exhaustive: never = selfDeal;
        throw new Error(`Unhandled self-dealing result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const outcome = await deps.db.$transaction(async (tx) => {
    const locked = await lockAuction(tx, input.auctionId);
    if (!locked || locked.status !== "LIVE" || !locked.endsAt || locked.endsAt <= now || (locked.startsAt && locked.startsAt > now)) {
      return { ok: false, reason: "AUCTION_CLOSED" } as const;
    }
    const prior = await tx.bid.findMany({
      where: { auctionId: locked.id },
      select: { id: true, bidderUserId: true, maxProxyCents: true, placedAt: true, status: true },
    });
    const before = computeStanding(prior, locked);
    const isLeader = before.leader?.bidderUserId === input.bidderUserId;
    const minimumCents = isLeader ? before.leader!.maxCents + 1 : minimumBid(before, locked);
    if (input.maxCents < minimumCents) return { ok: false, reason: "BID_TOO_LOW", minimumCents } as const;

    const projected = computeStanding(
      [...prior, { id: "~new", bidderUserId: input.bidderUserId, maxProxyCents: input.maxCents, placedAt: now, status: "ACTIVE" }],
      locked,
    );
    const bid = await tx.bid.create({
      data: {
        auctionId: locked.id,
        bidderUserId: input.bidderUserId,
        maxProxyCents: input.maxCents,
        amountCents: projected.priceCents!,
        priceBeforeCents: before.priceCents ?? locked.startingBidCents,
        placedAt: now,
        ipHash: ctx.ipHash ?? null,
        deviceIdHash: ctx.deviceIdHash ?? null,
      },
    });
    const softCloseMs = locked.softCloseMinutes * 60_000;
    let endsAt = locked.endsAt;
    if (softCloseMs > 0 && endsAt.getTime() - now.getTime() < softCloseMs) {
      endsAt = new Date(now.getTime() + softCloseMs);
      await tx.auction.update({ where: { id: locked.id }, data: { endsAt } });
    }
    let standing = await refreshStanding(tx, locked);
    await writeAuditEvent(tx, {
      actorUserId: input.bidderUserId,
      actorType: "USER",
      action: "auction.bid_placed",
      subjectType: "Auction",
      subjectId: locked.id,
      after: {
        bidId: bid.id,
        maxCents: input.maxCents,
        priceCents: standing.priceCents,
        leaderUserId: standing.leader?.bidderUserId ?? null,
        endsAt: endsAt.toISOString(),
        extended: endsAt.getTime() !== locked.endsAt.getTime(),
      },
      ipHash: ctx.ipHash,
    });
    const shill = await evaluateShill(tx, { auction: locked, bidderUserId: input.bidderUserId, now });
    if (shill.voided) standing = await refreshStanding(tx, locked);

    const outbidUserId =
      before.leader && before.leader.bidderUserId !== input.bidderUserId && standing.leader?.bidderUserId !== before.leader.bidderUserId
        ? before.leader.bidderUserId
        : null;
    const messages: EmailMessage[] = [];
    if (outbidUserId) {
      messages.push({
        to: await emailOf(tx, outbidUserId),
        subject: `You've been outbid on "${locked.listing.title}"`,
        text: `Someone outbid your maximum on "${locked.listing.title}". The price is now ${formatUsd(standing.priceCents!)}.\n\nBid again: ${deps.appUrl}/listings/${locked.listing.id}`,
      });
    }
    return {
      ok: true,
      bidId: bid.id,
      leading: standing.leader?.bidderUserId === input.bidderUserId,
      priceCents: standing.priceCents ?? locked.startingBidCents,
      endsAt,
      reserveMet: standing.reserveMet,
      voided: shill.voided,
      messages,
    } as const;
  });
  if (!outcome.ok) return outcome;
  await notify(deps, outcome.messages);
  return {
    ok: true,
    bidId: outcome.bidId,
    leading: outcome.leading,
    priceCents: outcome.priceCents,
    endsAt: outcome.endsAt,
    reserveMet: outcome.reserveMet,
    voided: outcome.voided,
  };
}

/** Scores the bidder after each bid; 50+ opens a SHILL signal, 80+ voids their bids on this auction. */
async function evaluateShill(tx: Tx, input: { auction: LockedAuction; bidderUserId: string; now: Date }) {
  const sellerUserId = input.auction.listing.sellerUserId;
  const since = new Date(input.now.getTime() - SHILL_LOOKBACK_DAYS * DAY_MS);
  const [userAId, userBId] = [input.bidderUserId, sellerUserId].sort();
  const weakLinks = await tx.accountLink.count({ where: { userAId, userBId, signal: { notIn: [...STRONG_SIGNALS] } } });
  const recentBids = await tx.bid.count({ where: { bidderUserId: input.bidderUserId, placedAt: { gte: since } } });
  const recentBidsOnSeller = await tx.bid.count({
    where: { bidderUserId: input.bidderUserId, placedAt: { gte: since }, auction: { listing: { sellerUserId } } },
  });
  const sellerAuctions = await tx.bid.findMany({
    where: { bidderUserId: input.bidderUserId, auction: { listing: { sellerUserId }, status: { notIn: ["SCHEDULED", "LIVE"] } } },
    distinct: ["auctionId"],
    select: { auctionId: true },
  });
  const sellerAuctionsWon = await tx.auction.count({ where: { winnerUserId: input.bidderUserId, listing: { sellerUserId } } });
  const recentRetractions = await tx.bidRetraction.count({
    where: { bid: { bidderUserId: input.bidderUserId }, status: "APPROVED", createdAt: { gte: since } },
  });
  const factors = {
    weakLinkToSeller: weakLinks > 0,
    recentBids,
    recentBidsOnSeller,
    sellerAuctionsBidOn: sellerAuctions.length,
    sellerAuctionsWon,
    recentRetractions,
  };
  const { score, reasons } = shillScore(factors);
  if (score < SHILL_SIGNAL_SCORE) return { score, voided: false };

  const existing = await tx.fraudSignal.findFirst({
    where: { detector: "SHILL", subjectType: "User", subjectId: input.bidderUserId, status: "OPEN", evidence: { path: ["auctionId"], equals: input.auction.id } },
    select: { id: true },
  });
  if (!existing) {
    await raiseFraudSignal(tx, {
      detector: "SHILL",
      subjectType: "User",
      subjectId: input.bidderUserId,
      score,
      evidence: { auctionId: input.auction.id, listingId: input.auction.listing.id, sellerUserId, factors, reasons },
    });
  }
  if (score < SHILL_VOID_SCORE) return { score, voided: false };
  const voided = await tx.bid.updateMany({
    where: { auctionId: input.auction.id, bidderUserId: input.bidderUserId, status: { in: ["ACTIVE", "WINNING", "OUTBID"] } },
    data: { status: "VOIDED_SHILL" },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "auction.bids_voided",
    subjectType: "Auction",
    subjectId: input.auction.id,
    after: { bidderUserId: input.bidderUserId, bids: voided.count, score, reasons },
  });
  return { score, voided: voided.count > 0 };
}

// ───────────── Closing, payment, non-payment ─────────────

async function createAuctionOrder(
  tx: Tx,
  deps: AuctionDeps,
  input: { auction: LockedAuction; buyerUserId: string; priceCents: number; source: Extract<OrderSource, "AUCTION" | "SECOND_CHANCE">; now: Date },
): Promise<Order> {
  const rates = feeRates(econ(deps));
  const prices = splitBuyerPrice(input.priceCents, rates);
  const { listing } = input.auction;
  const order = await tx.order.create({
    data: {
      listingId: listing.id,
      buyerUserId: input.buyerUserId,
      sellerUserId: listing.sellerUserId,
      storefrontId: listing.storefrontId,
      source: input.source,
      askingPriceCents: prices.askingCents,
      buyerFeeBps: rates.buyerFeeBps,
      buyerFeeCents: prices.buyerFeeCents,
      buyerPriceCents: prices.buyerPriceCents,
      sellerFeeBps: rates.sellerFeeBps,
      sellerFeeCents: prices.sellerFeeCents,
      sellerPayoutCents: prices.sellerPayoutCents,
      platformFeeCents: prices.platformFeeCents,
      shippingCents: listing.shippingCents,
      paymentDueAt: new Date(input.now.getTime() + input.auction.paymentWindowHours * 60 * 60 * 1000),
    },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "order.created",
    subjectType: "Order",
    subjectId: order.id,
    after: {
      listingId: listing.id,
      auctionId: input.auction.id,
      source: input.source,
      askingPriceCents: prices.askingCents,
      buyerPriceCents: prices.buyerPriceCents,
      sellerPayoutCents: prices.sellerPayoutCents,
      platformFeeCents: prices.platformFeeCents,
      shippingCents: listing.shippingCents,
    },
  });
  return order;
}

function winnerNotice(deps: AuctionDeps, to: string, title: string, order: Order, source: OrderSource): EmailMessage {
  const lead = source === "SECOND_CHANCE" ? `The seller is offering you "${title}" at your maximum bid` : `You won "${title}"`;
  return {
    to,
    subject: source === "SECOND_CHANCE" ? `Second-chance offer: "${title}"` : `You won "${title}"`,
    text: `${lead}: ${formatUsd(order.buyerPriceCents)} plus ${order.shippingCents > 0 ? `${formatUsd(order.shippingCents)} US shipping` : "free US shipping"}.\n\nPay by ${order.paymentDueAt!.toISOString().replace("T", " ").slice(0, 16)} UTC: ${deps.appUrl}/orders/${order.id}\n\nUnpaid wins are recorded as a non-paying-bidder strike; two in a year blocks bidding.`,
  };
}

type CloseOutcome = "SOLD" | "UNSOLD" | "SKIPPED";

/** Closes one auction that has reached its end time: an order for the winner, or unsold. */
export async function closeAuction(deps: AuctionDeps, auctionId: string): Promise<CloseOutcome> {
  const now = clock(deps);
  const result = await deps.db.$transaction(async (tx) => {
    const auction = await lockAuction(tx, auctionId);
    if (!auction || auction.status !== "LIVE" || !auction.endsAt || auction.endsAt > now) return { outcome: "SKIPPED" as const, messages: [] };
    const standing = await refreshStanding(tx, auction);
    const seller = await emailOf(tx, auction.listing.sellerUserId);
    if (!standing.leader || !standing.reserveMet) {
      await tx.auction.update({ where: { id: auction.id }, data: { status: "UNSOLD", closedAt: now } });
      await tx.listing.update({ where: { id: auction.listing.id }, data: { status: "ENDED" } });
      await recordListingOutcome(tx, { listingId: auction.listing.id, outcome: "UNSOLD_AUCTION", closedAt: now });
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "auction.closed_unsold",
        subjectType: "Auction",
        subjectId: auction.id,
        after: { bidCount: standing.ranking.length, highestMaxCents: standing.leader?.maxCents ?? null, reserveMet: standing.reserveMet },
      });
      return {
        outcome: "UNSOLD" as const,
        messages: [
          {
            to: seller,
            subject: `Your auction "${auction.listing.title}" ended unsold`,
            text: standing.leader
              ? `Bidding didn't reach your reserve. You can list the item again from your storefront.`
              : `There were no bids. You can list the item again from your storefront.`,
          },
        ],
      };
    }
    const order = await createAuctionOrder(tx, deps, {
      auction,
      buyerUserId: standing.leader.bidderUserId,
      priceCents: standing.priceCents!,
      source: "AUCTION",
      now,
    });
    await tx.auction.update({
      where: { id: auction.id },
      data: { status: "ENDED", closedAt: now, winnerUserId: standing.leader.bidderUserId, orderId: order.id },
    });
    await writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action: "auction.closed_sold",
      subjectType: "Auction",
      subjectId: auction.id,
      after: { winnerUserId: standing.leader.bidderUserId, priceCents: standing.priceCents, orderId: order.id },
    });
    return {
      outcome: "SOLD" as const,
      messages: [
        winnerNotice(deps, await emailOf(tx, standing.leader.bidderUserId), auction.listing.title, order, "AUCTION"),
        {
          to: seller,
          subject: `Your auction "${auction.listing.title}" sold for ${formatUsd(order.buyerPriceCents)}`,
          text: `The winner has ${auction.paymentWindowHours} hours to pay. You'll be asked to ship once payment is held. Your payout: ${formatUsd(order.sellerPayoutCents)} plus shipping.`,
        },
      ],
    };
  });
  await notify(deps, result.messages);
  return result.outcome;
}

export type PayAuctionResult = { ok: true; url: string } | { ok: false; reason: "NOT_FOUND" | "NOT_PAYABLE" | "CHECKOUT_PAUSED" };

/** Opens checkout for an auction or second-chance order inside its payment window. */
export async function payAuctionOrder(
  deps: AuctionDeps,
  input: { buyerUserId: string; buyerEmail: string; orderId: string },
): Promise<PayAuctionResult> {
  const now = clock(deps);
  const order = await deps.db.order.findUnique({
    where: { id: input.orderId },
    include: { listing: { select: { id: true, title: true } }, payments: { where: { status: "REQUIRES_PAYMENT" } } },
  });
  if (!order || order.buyerUserId !== input.buyerUserId || order.source === "FIXED") return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "CREATED" || !order.paymentDueAt || order.paymentDueAt <= now) return { ok: false, reason: "NOT_PAYABLE" };
  if (await isPaused(deps.db, "CHECKOUT")) return { ok: false, reason: "CHECKOUT_PAUSED" };
  for (const p of order.payments) {
    await deps.payments.expireCheckout(p.checkoutSessionId).catch(() => undefined);
    await deps.db.payment.update({ where: { id: p.id }, data: { status: "FAILED" } });
  }
  const expiresAt = new Date(
    Math.max(now.getTime() + CHECKOUT_MIN_MS, Math.min(order.paymentDueAt.getTime(), now.getTime() + CHECKOUT_MAX_MS)),
  );
  const url = await openCheckoutSession(deps, order, order.listing, input.buyerEmail, expiresAt);
  return { ok: true, url };
}

/** An auction order's payment window expired: record the strike and hand the decision to the seller. */
async function recordNonPayment(deps: AuctionDeps, auctionId: string): Promise<boolean> {
  const now = clock(deps);
  const config = platformConfig(deps);
  const result = await deps.db.$transaction(async (tx) => {
    const auction = await lockAuction(tx, auctionId);
    if (!auction || auction.status !== "ENDED" || !auction.orderId || !auction.winnerUserId) return null;
    const order = await tx.order.findUniqueOrThrow({ where: { id: auction.orderId } });
    if (order.status !== "EXPIRED") return null;
    await tx.nonPayingBidderStrike.create({ data: { userId: auction.winnerUserId, auctionId: auction.id, orderId: order.id } });
    const strikes = await activeStrikes(tx, auction.winnerUserId, now);
    if (strikes >= NONPAY_STRIKE_LIMIT) {
      await raiseFraudSignal(tx, {
        detector: "NONPAY",
        subjectType: "User",
        subjectId: auction.winnerUserId,
        score: Math.min(100, 40 * strikes),
        evidence: { strikes, auctionId: auction.id, orderId: order.id },
      });
    }
    const sellerDecisionDueAt = new Date(now.getTime() + config.auctionSellerDecisionDays * DAY_MS);
    await tx.auction.update({ where: { id: auction.id }, data: { status: "AWAITING_SELLER", sellerDecisionDueAt } });
    await writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action: "auction.winner_did_not_pay",
      subjectType: "Auction",
      subjectId: auction.id,
      after: { winnerUserId: auction.winnerUserId, orderId: order.id, strikes, sellerDecisionDueAt: sellerDecisionDueAt.toISOString() },
    });
    return [
      {
        to: await emailOf(tx, auction.winnerUserId),
        subject: `Unpaid: "${auction.listing.title}"`,
        text: `The payment window for "${auction.listing.title}" closed without payment, so a non-paying-bidder strike was recorded on your account (${strikes} in the last 12 months). ${strikes >= NONPAY_STRIKE_LIMIT ? "Bidding is now blocked pending review." : `${NONPAY_STRIKE_LIMIT} strikes blocks bidding.`} Reply to this email to appeal.`,
      },
      {
        to: await emailOf(tx, auction.listing.sellerUserId),
        subject: `The winner didn't pay for "${auction.listing.title}"`,
        text: `Choose a second-chance offer to the next bidder or relist it: ${deps.appUrl}/sell\n\nIf you don't choose by ${sellerDecisionDueAt.toISOString().slice(0, 10)}, we relist it automatically.`,
      },
    ];
  });
  if (!result) return false;
  await notify(deps, result);
  return true;
}

async function relist(tx: Tx, auction: LockedAuction, now: Date) {
  await tx.auction.update({ where: { id: auction.id }, data: { status: "RELISTED" } });
  const endsAt = new Date(now.getTime() + auction.durationDays * DAY_MS);
  return tx.auction.create({
    data: {
      listingId: auction.listing.id,
      status: "LIVE",
      startingBidCents: auction.startingBidCents,
      reserveCents: auction.reserveCents,
      isNoReserve: auction.isNoReserve,
      durationDays: auction.durationDays,
      softCloseMinutes: auction.softCloseMinutes,
      paymentWindowHours: auction.paymentWindowHours,
      startsAt: now,
      endsAt,
      originalEndsAt: endsAt,
      relistOfId: auction.id,
    },
  });
}

export type SellerDecisionResult =
  | { ok: true; decision: "SECOND_CHANCE"; orderId: string; buyerUserId: string }
  | { ok: true; decision: "RELIST"; auctionId: string }
  | { ok: false; reason: "AUCTIONS_DISABLED" | "NOT_FOUND" | "NOT_AWAITING_SELLER" | "NO_SECOND_BIDDER" };

/** After a non-paying winner: offer the item to the next eligible bidder at their maximum, or relist it. */
export async function decideAfterNonPayment(
  deps: AuctionDeps,
  input: { sellerUserId: string | null; auctionId: string; decision: "SECOND_CHANCE" | "RELIST" },
  ctx: RequestContext = {},
): Promise<SellerDecisionResult> {
  const now = clock(deps);
  if (!platformConfig(deps).auctionsEnabled) return { ok: false, reason: "AUCTIONS_DISABLED" };
  const result = await deps.db.$transaction(async (tx): Promise<{ result: SellerDecisionResult; messages: EmailMessage[] }> => {
    const auction = await lockAuction(tx, input.auctionId);
    if (!auction || (input.sellerUserId !== null && auction.listing.sellerUserId !== input.sellerUserId)) {
      return { result: { ok: false, reason: "NOT_FOUND" }, messages: [] };
    }
    if (auction.status !== "AWAITING_SELLER") return { result: { ok: false, reason: "NOT_AWAITING_SELLER" }, messages: [] };
    const actor = input.sellerUserId
      ? { actorUserId: input.sellerUserId, actorType: "USER" as const, ipHash: ctx.ipHash }
      : { actorType: "SYSTEM" as const };

    const decision = input.decision;
    switch (decision) {
      case "RELIST": {
        const next = await relist(tx, auction, now);
        await writeAuditEvent(tx, {
          ...actor,
          action: "auction.relisted",
          subjectType: "Auction",
          subjectId: auction.id,
          after: { newAuctionId: next.id, endsAt: next.endsAt!.toISOString(), automatic: input.sellerUserId === null },
        });
        return { result: { ok: true, decision, auctionId: next.id }, messages: [] };
      }
      case "SECOND_CHANCE": {
        const bids = await tx.bid.findMany({
          where: { auctionId: auction.id },
          select: { id: true, bidderUserId: true, maxProxyCents: true, placedAt: true, status: true },
        });
        const struck = new Set((await tx.nonPayingBidderStrike.findMany({ where: { auctionId: auction.id }, select: { userId: true } })).map((s) => s.userId));
        let candidate = null;
        for (const ranked of computeStanding(bids, auction).ranking) {
          if (struck.has(ranked.bidderUserId)) continue;
          const user = await tx.user.findUnique({ where: { id: ranked.bidderUserId }, select: { status: true } });
          if (user?.status !== "ACTIVE" || (await activeStrikes(tx, ranked.bidderUserId, now)) >= NONPAY_STRIKE_LIMIT) continue;
          const selfDeal = await checkSelfDealing(tx, {
            buyerUserId: ranked.bidderUserId,
            sellerUserId: auction.listing.sellerUserId,
            storefrontId: auction.listing.storefrontId,
          });
          if (!selfDeal.ok) continue;
          candidate = ranked;
          break;
        }
        if (!candidate) return { result: { ok: false, reason: "NO_SECOND_BIDDER" }, messages: [] };
        const order = await createAuctionOrder(tx, deps, {
          auction,
          buyerUserId: candidate.bidderUserId,
          priceCents: Math.max(candidate.maxCents, auction.startingBidCents),
          source: "SECOND_CHANCE",
          now,
        });
        await tx.auction.update({
          where: { id: auction.id },
          data: { status: "ENDED", winnerUserId: candidate.bidderUserId, orderId: order.id, sellerDecisionDueAt: null },
        });
        await writeAuditEvent(tx, {
          ...actor,
          action: "auction.second_chance_offered",
          subjectType: "Auction",
          subjectId: auction.id,
          after: { buyerUserId: candidate.bidderUserId, priceCents: order.buyerPriceCents, orderId: order.id },
        });
        return {
          result: { ok: true, decision, orderId: order.id, buyerUserId: candidate.bidderUserId },
          messages: [winnerNotice(deps, await emailOf(tx, candidate.bidderUserId), auction.listing.title, order, "SECOND_CHANCE")],
        };
      }
      default: {
        const exhaustive: never = decision;
        throw new Error(`Unhandled seller decision: ${String(exhaustive)}`);
      }
    }
  });
  await notify(deps, result.messages);
  return result.result;
}

export interface AuctionJobReport {
  enabled: boolean;
  sold: number;
  unsold: number;
  nonPayments: number;
  relisted: number;
}

const BATCH = 100;

/**
 * Auction timers, run after the escrow jobs (which expire unpaid orders):
 * close due auctions, record non-payments, relist when the seller doesn't
 * decide in time. Does nothing while AUCTIONS_ENABLED is off.
 */
export async function runAuctionJobs(deps: AuctionDeps): Promise<AuctionJobReport> {
  const report: AuctionJobReport = { enabled: platformConfig(deps).auctionsEnabled, sold: 0, unsold: 0, nonPayments: 0, relisted: 0 };
  if (!report.enabled) return report;
  const now = clock(deps);

  const due = await deps.db.auction.findMany({ where: { status: "LIVE", endsAt: { lte: now } }, select: { id: true }, take: BATCH });
  for (const a of due) {
    const outcome = await closeAuction(deps, a.id);
    if (outcome === "SOLD") report.sold++;
    if (outcome === "UNSOLD") report.unsold++;
  }

  const unpaid = await deps.db.auction.findMany({ where: { status: "ENDED", order: { status: "EXPIRED" } }, select: { id: true }, take: BATCH });
  for (const a of unpaid) if (await recordNonPayment(deps, a.id)) report.nonPayments++;

  const undecided = await deps.db.auction.findMany({
    where: { status: "AWAITING_SELLER", sellerDecisionDueAt: { lte: now } },
    select: { id: true },
    take: BATCH,
  });
  for (const a of undecided) {
    const r = await decideAfterNonPayment(deps, { sellerUserId: null, auctionId: a.id, decision: "RELIST" });
    if (r.ok) report.relisted++;
  }
  return report;
}

// ───────────── Retractions ─────────────

export type RetractionResult =
  | { ok: true; status: "APPROVED" | "PENDING" }
  | {
      ok: false;
      reason: "NOT_FOUND" | "AUCTION_CLOSED" | "ALREADY_RETRACTED" | "ALREADY_REQUESTED" | "QUOTA_EXCEEDED" | "FINAL_HOURS" | "NOT_A_TYPO" | "REASON_REQUIRED";
    };

/** Bidder-initiated retraction under the limits in engine.checkRetraction, with a 1-per-90-days quota. */
export async function requestRetraction(
  deps: AuctionDeps,
  input: { bidderUserId: string; bidId: string; kind: RetractionReason; reason: string },
  ctx: RequestContext = {},
): Promise<RetractionResult> {
  const now = clock(deps);
  const reason = input.reason.trim();
  if (reason.length < 10) return { ok: false, reason: "REASON_REQUIRED" };
  const bid = await deps.db.bid.findUnique({ where: { id: input.bidId }, select: { auctionId: true, bidderUserId: true } });
  if (!bid || bid.bidderUserId !== input.bidderUserId) return { ok: false, reason: "NOT_FOUND" };

  return deps.db.$transaction(async (tx): Promise<RetractionResult> => {
    const auction = await lockAuction(tx, bid.auctionId);
    if (!auction || auction.status !== "LIVE" || !auction.endsAt) return { ok: false, reason: "AUCTION_CLOSED" };
    const current = await tx.bid.findUniqueOrThrow({ where: { id: input.bidId }, include: { retraction: true } });
    if (!countsTowardPrice(current.status)) return { ok: false, reason: "ALREADY_RETRACTED" };
    if (current.retraction) return { ok: false, reason: "ALREADY_REQUESTED" };
    const used = await tx.bidRetraction.count({
      where: {
        bid: { bidderUserId: input.bidderUserId },
        OR: [{ status: "PENDING" }, { status: "APPROVED", createdAt: { gte: new Date(now.getTime() - RETRACTION_QUOTA_DAYS * DAY_MS) } }],
      },
    });
    if (used >= RETRACTION_QUOTA) return { ok: false, reason: "QUOTA_EXCEEDED" };
    const check = checkRetraction({
      kind: input.kind,
      maxProxyCents: current.maxProxyCents,
      priceBeforeCents: current.priceBeforeCents,
      placedAt: current.placedAt,
      endsAt: auction.endsAt,
      now,
    });
    if (check.outcome === "REFUSED") return { ok: false, reason: check.reason };
    const approved = check.outcome === "AUTO_APPROVE";
    const retraction = await tx.bidRetraction.create({
      data: { bidId: current.id, kind: input.kind, reason, status: approved ? "APPROVED" : "PENDING", decidedAt: approved ? now : null },
    });
    if (approved) await applyRetraction(tx, auction, current.id, input.bidderUserId, now);
    await writeAuditEvent(tx, {
      actorUserId: input.bidderUserId,
      actorType: "USER",
      action: approved ? "auction.bid_retracted" : "auction.retraction_requested",
      subjectType: "BidRetraction",
      subjectId: retraction.id,
      after: { auctionId: auction.id, bidId: current.id, kind: input.kind, reason, automatic: approved },
      ipHash: ctx.ipHash,
    });
    return { ok: true, status: approved ? "APPROVED" : "PENDING" };
  });
}

async function applyRetraction(tx: Tx, auction: LockedAuction, bidId: string, bidderUserId: string, now: Date) {
  await tx.bid.update({ where: { id: bidId }, data: { status: "RETRACTED" } });
  await refreshStanding(tx, auction);
  const lastYear = await tx.bidRetraction.count({
    where: { bid: { bidderUserId }, status: "APPROVED", createdAt: { gte: new Date(now.getTime() - 365 * DAY_MS) } },
  });
  if (lastYear >= 3) {
    await raiseFraudSignal(tx, {
      detector: "RETRACTION_ABUSE",
      subjectType: "User",
      subjectId: bidderUserId,
      score: Math.min(100, 20 * lastYear),
      evidence: { retractionsLastYear: lastYear, auctionId: auction.id, bidId },
    });
  }
}

export type DecideRetractionResult =
  | { ok: true }
  | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "ALREADY_DECIDED" | "PARTY_TO_AUCTION" | "AUCTION_CLOSED" | "NOTES_REQUIRED" };

/** Staff decision on a retraction that needs review (changed description, unreachable seller). */
export async function decideRetraction(
  deps: AuctionDeps,
  input: { staffUserId: string; retractionId: string; approve: boolean; notes: string },
  ctx: RequestContext = {},
): Promise<DecideRetractionResult> {
  const now = clock(deps);
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const request = await deps.db.bidRetraction.findUnique({
    where: { id: input.retractionId },
    include: { bid: { select: { auctionId: true, bidderUserId: true } } },
  });
  if (!request) return { ok: false, reason: "NOT_FOUND" };
  const result = await deps.db.$transaction(async (tx) => {
    const staff = await tx.user.findUnique({ where: { id: input.staffUserId }, select: { role: true } });
    if (!staff || !STAFF_ROLES.has(staff.role)) return { ok: false, reason: "NOT_STAFF" } as const;
    const auction = await lockAuction(tx, request.bid.auctionId);
    if (!auction) return { ok: false, reason: "NOT_FOUND" } as const;
    if (input.staffUserId === request.bid.bidderUserId || input.staffUserId === auction.listing.sellerUserId) {
      return { ok: false, reason: "PARTY_TO_AUCTION" } as const;
    }
    if (input.approve && auction.status !== "LIVE") return { ok: false, reason: "AUCTION_CLOSED" } as const;
    const claimed = await tx.bidRetraction.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: input.approve ? "APPROVED" : "DENIED", approvedById: input.staffUserId, decisionNotes: notes, decidedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, reason: "ALREADY_DECIDED" } as const;
    if (input.approve) await applyRetraction(tx, auction, request.bidId, request.bid.bidderUserId, now);
    await writeAuditEvent(tx, {
      actorUserId: input.staffUserId,
      actorType: "ADMIN",
      action: input.approve ? "auction.retraction_approved" : "auction.retraction_denied",
      subjectType: "BidRetraction",
      subjectId: request.id,
      after: { auctionId: auction.id, bidId: request.bidId, notes },
      ipHash: ctx.ipHash,
    });
    return {
      ok: true,
      message: {
        to: await emailOf(tx, request.bid.bidderUserId),
        subject: input.approve ? "Your bid retraction was approved" : "Your bid retraction was declined",
        text: input.approve
          ? `Your bid on "${auction.listing.title}" was retracted.\n\n${notes}`
          : `Your bid on "${auction.listing.title}" stands.\n\n${notes}`,
      },
    } as const;
  });
  if (!result.ok) return result;
  await notify(deps, [result.message]);
  return { ok: true };
}

// ───────────── Staff voids ─────────────

export type VoidBidsResult =
  | { ok: true; voided: number; enforcementId: string }
  | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "AUCTION_CLOSED" | "NO_BIDS" | "REASON_REQUIRED" | "SELF_ACTION" };

/** Trust and safety voids a bidder's bids on a live auction (shill bidding) and records a BID_VOID enforcement. */
export async function voidBids(
  deps: AuctionDeps,
  input: { staffUserId: string; auctionId: string; bidderUserId: string; reason: string; fraudSignalId?: string | null },
  ctx: RequestContext = {},
): Promise<VoidBidsResult> {
  const now = clock(deps);
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  if (input.staffUserId === input.bidderUserId) return { ok: false, reason: "SELF_ACTION" };
  const result = await deps.db.$transaction(async (tx) => {
    const staff = await tx.user.findUnique({ where: { id: input.staffUserId }, select: { role: true } });
    if (!staff || !STAFF_ROLES.has(staff.role)) return { ok: false, reason: "NOT_STAFF" } as const;
    const auction = await lockAuction(tx, input.auctionId);
    if (!auction) return { ok: false, reason: "NOT_FOUND" } as const;
    if (auction.status !== "LIVE") return { ok: false, reason: "AUCTION_CLOSED" } as const;
    const voided = await tx.bid.updateMany({
      where: { auctionId: auction.id, bidderUserId: input.bidderUserId, status: { in: ["ACTIVE", "WINNING", "OUTBID"] } },
      data: { status: "VOIDED_SHILL" },
    });
    if (voided.count === 0) return { ok: false, reason: "NO_BIDS" } as const;
    await refreshStanding(tx, auction);
    const action = await tx.enforcementAction.create({
      data: { userId: input.bidderUserId, type: "BID_VOID", reason, actorId: input.staffUserId, fraudSignalId: input.fraudSignalId ?? null },
    });
    if (input.fraudSignalId) {
      await tx.fraudSignal.updateMany({
        where: { id: input.fraudSignalId, status: "OPEN" },
        data: { status: "CONFIRMED", reviewedById: input.staffUserId, reviewedAt: now, reviewNotes: reason },
      });
    }
    await writeAuditEvent(tx, {
      actorUserId: input.staffUserId,
      actorType: "ADMIN",
      action: "enforcement.issued",
      subjectType: "User",
      subjectId: input.bidderUserId,
      after: { enforcementId: action.id, type: "BID_VOID", reason, auctionId: auction.id, bids: voided.count, fraudSignalId: input.fraudSignalId ?? null },
      ipHash: ctx.ipHash,
    });
    return {
      ok: true,
      voided: voided.count,
      enforcementId: action.id,
      message: {
        to: await emailOf(tx, input.bidderUserId),
        subject: "Your bids on an auction were voided",
        text: `Our trust and safety team voided your bids on "${auction.listing.title}":\n\n${reason}\n\nRepeated issues lead to fee forfeiture, suspension, or a ban. Reply to this email to appeal.`,
      },
    } as const;
  });
  if (!result.ok) return result;
  await notify(deps, [result.message]);
  return { ok: true, voided: result.voided, enforcementId: result.enforcementId };
}

/** Public auction state for the listing page; never exposes the reserve or anyone's maximum. */
export async function auctionView(db: OrdersDeps["db"], listing: Pick<Listing, "id">, viewerId: string | null) {
  const auction = await db.auction.findFirst({
    where: { listingId: listing.id },
    orderBy: { createdAt: "desc" },
    include: {
      bids: {
        where: { status: { in: ["ACTIVE", "WINNING", "OUTBID"] } },
        orderBy: { placedAt: "desc" },
        take: 50,
        select: { id: true, bidderUserId: true, amountCents: true, maxProxyCents: true, priceBeforeCents: true, placedAt: true, status: true, retraction: { select: { status: true } } },
      },
    },
  });
  if (!auction) return null;
  const terms = { startingBidCents: auction.startingBidCents, reserveCents: auction.reserveCents };
  const aliases = new Map<string, string>();
  for (const b of [...auction.bids].reverse()) if (!aliases.has(b.bidderUserId)) aliases.set(b.bidderUserId, `Bidder ${aliases.size + 1}`);
  const mine = viewerId ? auction.bids.filter((b) => b.bidderUserId === viewerId) : [];
  const leading = viewerId !== null && auction.bids.some((b) => b.bidderUserId === viewerId && b.status === "WINNING");
  return {
    id: auction.id,
    status: auction.status,
    endsAt: auction.endsAt,
    paymentWindowHours: auction.paymentWindowHours,
    priceCents: auction.currentPriceCents,
    startingBidCents: auction.startingBidCents,
    minimumBidCents: minimumBid({ priceCents: auction.currentPriceCents }, terms),
    hasReserve: !auction.isNoReserve,
    reserveMet: auction.reserveMet,
    bidCount: auction.bidCount,
    winnerUserId: auction.winnerUserId,
    orderId: auction.orderId,
    leading,
    myMaxCents: mine.length > 0 ? Math.max(...mine.map((b) => b.maxProxyCents)) : null,
    myBids: mine.map((b) => ({ id: b.id, maxCents: b.maxProxyCents, placedAt: b.placedAt, retractionStatus: b.retraction?.status ?? null })),
    history: auction.bids.map((b) => ({ id: b.id, bidder: aliases.get(b.bidderUserId)!, priceCents: b.amountCents, placedAt: b.placedAt })),
  };
}

export type AuctionView = NonNullable<Awaited<ReturnType<typeof auctionView>>>;
