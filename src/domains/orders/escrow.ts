import { writeAuditEvent, type AuditInput, type Tx } from "@/domains/audit/audit";
import { accounts, post } from "@/domains/payments/ledger";
import { recordListingOutcome } from "@/domains/listings/outcomes";
import { recomputeVolumeBadges } from "@/domains/growth/badges";
import { accrueReferralEarning } from "@/domains/growth/referrals";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import type { Order, OrderStatus } from "@/generated/prisma/client";
import { clock, econ, platformConfig, type OrdersDeps } from "./deps";
import { nextStatus, type OrderEvent } from "./state-machine";

type Actor = Pick<AuditInput, "actorUserId" | "actorType" | "ipHash">;

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly event: OrderEvent,
  ) {
    super(`Order can't go from ${from} on ${event}`);
  }
}

/** Moves the order along one edge of the state machine, with a status precondition to stop races. */
export async function transition(
  tx: Tx,
  order: Pick<Order, "id" | "status">,
  event: OrderEvent,
  data: Omit<Parameters<Tx["order"]["update"]>[0]["data"], "status"> = {},
): Promise<OrderStatus> {
  const to = nextStatus(order.status, event);
  if (!to) throw new IllegalTransitionError(order.status, event);
  const updated = await tx.order.updateMany({ where: { id: order.id, status: order.status }, data: { ...data, status: to } });
  if (updated.count !== 1) throw new IllegalTransitionError(order.status, event);
  return to;
}

/** What the seller is paid on release: payout plus the shipping they charged. */
export const sellerShareCents = (o: Pick<Order, "sellerPayoutCents" | "shippingCents">) => o.sellerPayoutCents + o.shippingCents;

/**
 * Releases held funds to the seller. Ledger and Transfer row are written in
 * the caller's transaction; the provider call happens after commit
 * (executeTransfer) and is retried by the escrow job until it succeeds.
 */
export async function releaseFunds(
  tx: Tx,
  deps: OrdersDeps,
  order: Order,
  event: Extract<OrderEvent, "BUYER_CONFIRMED" | "AUTO_RELEASE" | "DISPUTE_RELEASE" | "DISPUTE_PARTIAL">,
  actor: Actor,
  refundCents = 0,
): Promise<{ transferId: string | null; status: OrderStatus }> {
  const now = clock(deps);
  const status = await transition(tx, order, event, { releasedAt: now });
  const sellerShare = sellerShareCents(order) - refundCents;
  if (sellerShare < 0) throw new Error("Refund exceeds the seller's share");
  await post(tx, [
    {
      debit: accounts.buyerHeld(order.id),
      credit: accounts.sellerPayable(order.sellerUserId),
      amountCents: sellerShare,
      memo: "Release: seller payout + shipping",
      orderId: order.id,
    },
    {
      debit: accounts.buyerHeld(order.id),
      credit: accounts.platformRevenue(),
      amountCents: order.platformFeeCents,
      memo: "Release: buyer fee + seller fee",
      orderId: order.id,
    },
    {
      debit: accounts.buyerHeld(order.id),
      credit: accounts.taxPayable(),
      amountCents: order.taxCents,
      memo: "Release: sales tax collected",
      orderId: order.id,
    },
  ]);

  let transferId: string | null = null;
  if (sellerShare > 0) {
    const storefront = await tx.storefront.findUniqueOrThrow({ where: { id: order.storefrontId } });
    if (!storefront.stripeAccountId) throw new Error("Storefront has no payout account");
    const transfer = await tx.transfer.create({
      data: {
        orderId: order.id,
        idempotencyKey: `order:${order.id}:release`,
        destinationAccountId: storefront.stripeAccountId,
        amountCents: sellerShare,
      },
    });
    transferId = transfer.id;
  }
  await accrueReferralEarning(tx, { economics: econ(deps), now }, order, refundCents);
  for (const userId of [order.sellerUserId, order.buyerUserId]) {
    await recomputeVolumeBadges(tx, userId, { config: platformConfig(deps), now });
  }
  await recordListingOutcome(tx, {
    listingId: order.listingId,
    outcome: "SOLD",
    salePriceCents: order.buyerPriceCents,
    closedAt: now,
  });
  await writeAuditEvent(tx, {
    ...actor,
    action: "order.released",
    subjectType: "Order",
    subjectId: order.id,
    before: { status: order.status },
    after: { status, event, sellerShareCents: sellerShare, platformFeeCents: order.platformFeeCents, refundCents },
  });
  return { transferId, status };
}

/** Queues a refund of `amountCents` of the buyer's charge; executeRefund sends it after commit. */
export async function queueRefund(
  tx: Tx,
  order: Pick<Order, "id">,
  input: { amountCents: number; reason: string; key: string },
): Promise<string> {
  const refund = await tx.refund.create({
    data: {
      orderId: order.id,
      idempotencyKey: `order:${order.id}:refund:${input.key}`,
      amountCents: input.amountCents,
      reason: input.reason,
    },
  });
  return refund.id;
}

/** Full refund of a paid order that never released, with the listing returned to sale when possible. */
export async function refundInFull(
  tx: Tx,
  deps: OrdersDeps,
  order: Order,
  event: Extract<OrderEvent, "SELLER_CANCELLED" | "SHIP_DEADLINE_MISSED" | "DISPUTE_REFUND">,
  actor: Actor,
  reason: string,
): Promise<{ refundId: string; status: OrderStatus }> {
  const status = await transition(tx, order, event);
  const paid = await tx.payment.aggregate({
    where: { orderId: order.id, status: "SUCCEEDED" },
    _sum: { amountCents: true },
  });
  const amount = paid._sum.amountCents ?? 0;
  if (amount <= 0) throw new Error("Order has no successful payment to refund");
  const refundId = await queueRefund(tx, order, { amountCents: amount, reason, key: "full" });

  const listing = await tx.listing.findUniqueOrThrow({ where: { id: order.listingId } });
  if (listing.status === "SOLD") {
    const canRelist = event !== "DISPUTE_REFUND" && (await checkIdentityGate(tx, order.sellerUserId, "SELL")).ok;
    await tx.listing.update({ where: { id: listing.id }, data: { status: canRelist ? "LIVE" : "ENDED" } });
  }
  await writeAuditEvent(tx, {
    ...actor,
    action: "order.refunded",
    subjectType: "Order",
    subjectId: order.id,
    before: { status: order.status },
    after: { status, event, amountCents: amount, reason },
  });
  return { refundId, status };
}

const MAX_PROVIDER_ATTEMPTS = 10;

export async function executeTransfer(deps: OrdersDeps, transferId: string): Promise<boolean> {
  const transfer = await deps.db.transfer.findUniqueOrThrow({ where: { id: transferId }, include: { order: true } });
  if (transfer.status !== "PENDING" || transfer.attempts >= MAX_PROVIDER_ATTEMPTS) return transfer.status === "PAID";
  const payment = await deps.db.payment.findFirst({
    where: { orderId: transfer.orderId, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] }, stripeChargeId: { not: null } },
  });
  if (!payment?.stripeChargeId) throw new Error(`Order ${transfer.orderId} has no charge to transfer from`);
  try {
    const result = await deps.payments.createTransfer({
      accountId: transfer.destinationAccountId,
      amountCents: transfer.amountCents,
      sourceChargeId: payment.stripeChargeId,
      transferGroup: `order_${transfer.orderId}`,
      idempotencyKey: transfer.idempotencyKey,
    });
    await deps.db.$transaction(async (tx) => {
      await tx.transfer.update({
        where: { id: transfer.id },
        data: { status: "PAID", stripeTransferId: result.transferId, attempts: { increment: 1 }, lastError: null },
      });
      await post(tx, [
        {
          debit: accounts.sellerPayable(transfer.order.sellerUserId),
          credit: accounts.cash(),
          amountCents: transfer.amountCents,
          memo: "Transfer to seller's payout account",
          orderId: transfer.orderId,
        },
      ]);
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "payment.transfer_paid",
        subjectType: "Transfer",
        subjectId: transfer.id,
        after: { orderId: transfer.orderId, amountCents: transfer.amountCents, providerId: result.transferId },
      });
    });
    return true;
  } catch (err) {
    await deps.db.transfer.update({
      where: { id: transfer.id },
      data: { attempts: { increment: 1 }, lastError: String(err instanceof Error ? err.message : err).slice(0, 500) },
    });
    return false;
  }
}

export async function executeRefund(deps: OrdersDeps, refundId: string): Promise<boolean> {
  const refund = await deps.db.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status === "SUCCEEDED") return true;
  if (refund.attempts >= MAX_PROVIDER_ATTEMPTS) return false;
  const payment = await deps.db.payment.findFirst({
    where: { orderId: refund.orderId, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] }, stripeChargeId: { not: null } },
  });
  if (!payment?.stripeChargeId) throw new Error(`Order ${refund.orderId} has no charge to refund`);
  try {
    const result = await deps.payments.createRefund({
      chargeId: payment.stripeChargeId,
      amountCents: refund.amountCents,
      idempotencyKey: refund.idempotencyKey,
    });
    await deps.db.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: "SUCCEEDED", stripeRefundId: result.refundId, attempts: { increment: 1 }, lastError: null },
      });
      const refunded = await tx.refund.aggregate({
        where: { orderId: refund.orderId, status: "SUCCEEDED" },
        _sum: { amountCents: true },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: (refunded._sum.amountCents ?? 0) >= payment.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED" },
      });
      await post(tx, [
        {
          debit: accounts.buyerHeld(refund.orderId),
          credit: accounts.cash(),
          amountCents: refund.amountCents,
          memo: `Refund to buyer: ${refund.reason}`,
          orderId: refund.orderId,
        },
      ]);
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "payment.refund_succeeded",
        subjectType: "Refund",
        subjectId: refund.id,
        after: { orderId: refund.orderId, amountCents: refund.amountCents, providerId: result.refundId },
      });
    });
    return true;
  } catch (err) {
    await deps.db.refund.update({
      where: { id: refund.id },
      data: {
        status: "FAILED",
        attempts: { increment: 1 },
        lastError: String(err instanceof Error ? err.message : err).slice(0, 500),
      },
    });
    return false;
  }
}
