"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/actions/auth";
import {
  decideAfterNonPayment,
  decideRetraction,
  MAX_BID_CENTS,
  payAuctionOrder,
  placeBid,
  requestRetraction,
  voidBids,
} from "@/domains/auctions/auctions";
import { RetractionReason } from "@/generated/prisma/enums";
import { formatUsd, parseUsdToCents } from "@/domains/pricing/pricing";
import { requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { auctionDeps } from "@/lib/payments/orders-deps";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

async function listingPath(auctionId: string) {
  const auction = await db.auction.findUnique({ where: { id: auctionId }, select: { listingId: true } });
  return auction ? `/listings/${auction.listingId}` : "/browse";
}

export async function placeBidAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const auctionId = str(formData, "auctionId");
  const maxCents = parseUsdToCents(str(formData, "maxBid"));
  if (maxCents === null) return { status: "error", message: "Enter your maximum bid, like 125 or 125.50." };
  const result = await placeBid(auctionDeps(), { auctionId, bidderUserId: user.id, maxCents }, await requestContext());
  if (result.ok) {
    revalidatePath(await listingPath(auctionId));
    if (result.voided) return { status: "error", message: "This bid can't be accepted. Contact support if you think this is a mistake." };
    return {
      status: "success",
      message: result.leading
        ? `You're the high bidder at ${formatUsd(result.priceCents)}. We'll bid for you up to your maximum.${result.reserveMet ? "" : " The reserve isn't met yet."}`
        : `Another bidder's maximum is higher. The price is now ${formatUsd(result.priceCents)}.`,
    };
  }
  const reason = result.reason;
  switch (reason) {
    case "BID_TOO_LOW":
      return { status: "error", message: `Your maximum must be at least ${formatUsd(result.minimumCents)}.` };
    case "BID_TOO_HIGH":
      return { status: "error", message: `Bids are limited to ${formatUsd(MAX_BID_CENTS)}.` };
    case "AUCTIONS_DISABLED":
      return { status: "error", message: "Auctions aren't available yet." };
    case "NOT_VERIFIED":
      return { status: "error", message: "Verify your identity before bidding." };
    case "UNDER_REVIEW":
      return { status: "error", message: "Your identity verification is being reviewed. You can bid once it's approved." };
    case "BLOCKED":
    case "ACCOUNT_RESTRICTED":
      return { status: "error", message: "This account can't bid. Contact support." };
    case "BIDDING_RESTRICTED":
      return { status: "error", message: "Bidding is paused on your account after unpaid wins. Contact support to appeal." };
    case "AUCTION_CLOSED":
      return { status: "error", message: "This auction has ended." };
    case "OWN_LISTING":
      return { status: "error", message: "You can't bid on your own item." };
    case "SELF_DEALING":
      return { status: "error", message: "This bid can't be accepted. Contact support if you think this is a mistake." };
    case "BIDDING_PAUSED":
      return { status: "error", message: "Bidding is paused for a moment while we sort something out. Please try again later." };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled bid failure: ${String(exhaustive)}`);
    }
  }
}

const isRetractionReason = (v: string): v is RetractionReason => (Object.values(RetractionReason) as string[]).includes(v);

export async function retractBidAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const kind = str(formData, "kind");
  if (!isRetractionReason(kind)) return { status: "error", message: "Choose a reason." };
  const result = await requestRetraction(
    auctionDeps(),
    { bidderUserId: user.id, bidId: str(formData, "bidId"), kind, reason: str(formData, "reason") },
    await requestContext(),
  );
  if (result.ok) {
    revalidatePath("/listings/[id]", "page");
    return {
      status: "success",
      message: result.status === "APPROVED" ? "Bid retracted. Enter the bid you meant, if any." : "Sent to our team for review. Your bid stands until they decide.",
    };
  }
  const reason = result.reason;
  switch (reason) {
    case "REASON_REQUIRED":
      return { status: "error", message: "Explain what happened (at least 10 characters)." };
    case "QUOTA_EXCEEDED":
      return { status: "error", message: "You can retract one bid every 90 days, and you've used it (or one is waiting for review)." };
    case "FINAL_HOURS":
      return { status: "error", message: "Bids can't be retracted in the last 12 hours, except a typo fixed within a minute." };
    case "NOT_A_TYPO":
      return { status: "error", message: "A typo retraction is for a bid at least 10× the price before it. Choose another reason if one applies." };
    case "AUCTION_CLOSED":
      return { status: "error", message: "This auction has ended." };
    case "ALREADY_RETRACTED":
    case "ALREADY_REQUESTED":
      return { status: "error", message: "This bid was already retracted or is under review." };
    case "NOT_FOUND":
      return { status: "error", message: "Bid not found." };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled retraction failure: ${String(exhaustive)}`);
    }
  }
}

export async function payAuctionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const result = await payAuctionOrder(auctionDeps(), { buyerUserId: user.id, buyerEmail: user.email, orderId: str(formData, "orderId") });
  if (result.ok) redirect(result.url);
  switch (result.reason) {
    case "NOT_PAYABLE":
      return { status: "error", message: "The payment window for this order has closed." };
    case "NOT_FOUND":
      return { status: "error", message: "Order not found." };
    case "CHECKOUT_PAUSED":
      return { status: "error", message: "Checkout is paused for a moment. Your payment window is unchanged; please try again shortly." };
    default: {
      const exhaustive: never = result.reason;
      throw new Error(`Unhandled auction payment failure: ${String(exhaustive)}`);
    }
  }
}

export async function sellerAuctionDecisionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const decision = str(formData, "decision");
  if (decision !== "SECOND_CHANCE" && decision !== "RELIST") return { status: "error", message: "Choose an option." };
  const result = await decideAfterNonPayment(
    auctionDeps(),
    { sellerUserId: user.id, auctionId: str(formData, "auctionId"), decision },
    await requestContext(),
  );
  if (result.ok) {
    revalidatePath("/sell");
    return {
      status: "success",
      message: result.decision === "RELIST" ? "Relisted. The new auction is live." : "Offer sent to the next bidder. They have the same payment window.",
    };
  }
  const reason = result.reason;
  switch (reason) {
    case "NO_SECOND_BIDDER":
      return { status: "error", message: "No other eligible bidder. Relist instead." };
    case "AUCTIONS_DISABLED":
      return { status: "error", message: "Auctions are switched off." };
    case "NOT_FOUND":
    case "NOT_AWAITING_SELLER":
      return { status: "error", message: "This auction isn't waiting on a decision." };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled seller decision failure: ${String(exhaustive)}`);
    }
  }
}

export async function decideRetractionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const decision = str(formData, "decision");
  if (decision !== "APPROVE" && decision !== "DENY") return { status: "error", message: "Choose a decision." };
  const result = await decideRetraction(
    auctionDeps(),
    { staffUserId: staff.id, retractionId: str(formData, "retractionId"), approve: decision === "APPROVE", notes: str(formData, "notes") },
    await requestContext(),
  );
  if (result.ok) {
    revalidatePath("/admin/trust");
    return { status: "success", message: decision === "APPROVE" ? "Retraction approved." : "Retraction declined." };
  }
  const reason = result.reason;
  switch (reason) {
    case "NOTES_REQUIRED":
      return { status: "error", message: "Explain the decision (the bidder sees it)." };
    case "PARTY_TO_AUCTION":
      return { status: "error", message: "You're the bidder or seller. Another staff member must decide." };
    case "AUCTION_CLOSED":
      return { status: "error", message: "The auction has ended; the bid can only be declined now." };
    case "NOT_STAFF":
    case "NOT_FOUND":
    case "ALREADY_DECIDED":
      return { status: "error", message: "This request is no longer open." };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled retraction decision failure: ${String(exhaustive)}`);
    }
  }
}

export async function voidBidsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const result = await voidBids(
    auctionDeps(),
    {
      staffUserId: staff.id,
      auctionId: str(formData, "auctionId"),
      bidderUserId: str(formData, "bidderUserId"),
      reason: str(formData, "reason"),
      fraudSignalId: str(formData, "fraudSignalId") || null,
    },
    await requestContext(),
  );
  if (result.ok) {
    revalidatePath("/admin/trust");
    return { status: "success", message: `Voided ${result.voided} bid${result.voided === 1 ? "" : "s"}.` };
  }
  const reason = result.reason;
  switch (reason) {
    case "REASON_REQUIRED":
      return { status: "error", message: "Give a reason (at least 5 characters)." };
    case "SELF_ACTION":
      return { status: "error", message: "You can't void your own bids." };
    case "AUCTION_CLOSED":
      return { status: "error", message: "Bids can only be voided while the auction is live." };
    case "NO_BIDS":
      return { status: "error", message: "That bidder has no live bids on this auction." };
    case "NOT_STAFF":
    case "NOT_FOUND":
      return { status: "error", message: "Auction not found." };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled void failure: ${String(exhaustive)}`);
    }
  }
}
