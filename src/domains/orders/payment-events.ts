import { hmacHex } from "@/lib/crypto";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import { recomputeVolumeBadges } from "@/domains/growth/badges";
import { clawBackOrderEarnings } from "@/domains/growth/referrals";
import { accounts, post } from "@/domains/payments/ledger";
import type { PaymentEvent, ShippingAddress } from "@/domains/payments/provider";
import {
  checkSelfDealing,
  linkByPaymentFingerprint,
  linkByShippingAddress,
  raiseFraudSignal,
} from "@/domains/trust/linkage";
import { clock, type OrdersDeps } from "./deps";
import { executeRefund, queueRefund, transition } from "./escrow";
import { HELD_STATUSES } from "./state-machine";

export type ProcessPaymentEventResult =
  | { outcome: "DUPLICATE_EVENT" | "UNKNOWN" | "IGNORED" }
  | { outcome: "PAID"; orderId: string; held: boolean }
  | { outcome: "LATE_PAYMENT_REFUNDED"; orderId: string }
  | { outcome: "EXPIRED"; orderId: string }
  | { outcome: "ACCOUNT_UPDATED"; storefrontId: string; payoutsEnabled: boolean }
  | { outcome: "CHARGEBACK"; orderId: string };

export function normalizeAddress(a: ShippingAddress): string {
  const clean = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return [a.line1, a.line2, a.city, a.state, a.postalCode.slice(0, 5), a.country].map(clean).join("|");
}

/** Applies one payment-provider event exactly once (webhook retries are skipped by event id). */
export async function processPaymentEvent(deps: OrdersDeps, event: PaymentEvent): Promise<ProcessPaymentEventResult> {
  const pendingRefunds: string[] = [];
  const result = await deps.db.$transaction(async (tx): Promise<ProcessPaymentEventResult> => {
    const inserted = await tx.webhookEvent.createMany({
      data: [{ id: event.eventId, provider: deps.payments.name, type: event.kind, processedAt: clock(deps) }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { outcome: "DUPLICATE_EVENT" };

    switch (event.kind) {
      case "CHECKOUT_COMPLETED":
        return checkoutCompleted(tx, deps, event, pendingRefunds);
      case "CHECKOUT_EXPIRED":
        return checkoutExpired(tx, event);
      case "ACCOUNT_UPDATED":
        return accountUpdated(tx, event);
      case "CHARGE_DISPUTED":
        return chargeDisputed(tx, event);
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled payment event: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
  for (const id of pendingRefunds) await executeRefund(deps, id);
  return result;
}

async function checkoutCompleted(
  tx: Tx,
  deps: OrdersDeps,
  event: Extract<PaymentEvent, { kind: "CHECKOUT_COMPLETED" }>,
  pendingRefunds: string[],
): Promise<ProcessPaymentEventResult> {
  const payment = await tx.payment.findUnique({
    where: { checkoutSessionId: event.checkoutSessionId },
    include: { order: true },
  });
  if (!payment) {
    await writeAuditEvent(tx, {
      actorType: "WEBHOOK",
      action: "payment.unknown_checkout",
      subjectType: "Payment",
      after: { checkoutSessionId: event.checkoutSessionId },
    });
    return { outcome: "UNKNOWN" };
  }
  const order = payment.order;
  const fingerprintHash = event.paymentFingerprint
    ? hmacHex(deps.linkageSecret, `card:${event.paymentFingerprint}`)
    : null;
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: "SUCCEEDED",
      stripePaymentIntentId: event.paymentIntentId,
      stripeChargeId: event.chargeId,
      amountCents: event.amountCents,
      paymentFingerprintHash: fingerprintHash,
    },
  });
  await post(tx, [
    {
      debit: accounts.cash(),
      credit: accounts.buyerHeld(order.id),
      amountCents: event.amountCents,
      memo: "Buyer payment held",
      orderId: order.id,
    },
  ]);

  if (order.status !== "CREATED") {
    pendingRefunds.push(await queueRefund(tx, order, { amountCents: event.amountCents, reason: "Paid after the checkout expired", key: `late:${payment.id}` }));
    await writeAuditEvent(tx, {
      actorType: "WEBHOOK",
      action: "order.late_payment_refunded",
      subjectType: "Order",
      subjectId: order.id,
      after: { status: order.status, amountCents: event.amountCents },
    });
    return { outcome: "LATE_PAYMENT_REFUNDED", orderId: order.id };
  }

  const addressHash = event.shippingAddress
    ? hmacHex(deps.linkageSecret, `address:${normalizeAddress(event.shippingAddress)}`)
    : null;
  await transition(tx, order, "PAYMENT_SUCCEEDED", {
    paidAt: clock(deps),
    taxCents: event.taxCents,
    shippingAddress: event.shippingAddress ? { ...event.shippingAddress } : undefined,
    shippingAddressHash: addressHash,
  });
  await tx.listing.update({ where: { id: order.listingId }, data: { status: "SOLD" } });

  if (fingerprintHash) await linkByPaymentFingerprint(tx, order.buyerUserId, fingerprintHash);
  if (addressHash) await linkByShippingAddress(tx, order.buyerUserId, addressHash);
  const selfDeal = await checkSelfDealing(tx, {
    buyerUserId: order.buyerUserId,
    sellerUserId: order.sellerUserId,
    storefrontId: order.storefrontId,
  });
  const held = !selfDeal.ok;
  if (held) {
    await tx.order.update({
      where: { id: order.id },
      data: { releaseHold: true, releaseHoldReason: "Buyer is linked to the seller (possible self-purchase)" },
    });
    await raiseFraudSignal(tx, {
      detector: "SELF_BUY",
      subjectType: "Order",
      subjectId: order.id,
      score: 85,
      evidence: { buyerUserId: order.buyerUserId, sellerUserId: order.sellerUserId, check: selfDeal },
    });
  }
  await writeAuditEvent(tx, {
    actorType: "WEBHOOK",
    action: "order.paid",
    subjectType: "Order",
    subjectId: order.id,
    before: { status: "CREATED" },
    after: { status: "PAID_HELD", amountCents: event.amountCents, taxCents: event.taxCents, releaseHold: held },
  });
  return { outcome: "PAID", orderId: order.id, held };
}

async function checkoutExpired(
  tx: Tx,
  event: Extract<PaymentEvent, { kind: "CHECKOUT_EXPIRED" }>,
): Promise<ProcessPaymentEventResult> {
  const payment = await tx.payment.findUnique({
    where: { checkoutSessionId: event.checkoutSessionId },
    include: { order: true },
  });
  if (!payment) return { outcome: "UNKNOWN" };
  if (payment.status === "REQUIRES_PAYMENT") {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
  }
  if (payment.order.status !== "CREATED") return { outcome: "IGNORED" };
  await transition(tx, payment.order, "PAYMENT_WINDOW_EXPIRED");
  await writeAuditEvent(tx, {
    actorType: "WEBHOOK",
    action: "order.expired",
    subjectType: "Order",
    subjectId: payment.orderId,
  });
  return { outcome: "EXPIRED", orderId: payment.orderId };
}

async function accountUpdated(
  tx: Tx,
  event: Extract<PaymentEvent, { kind: "ACCOUNT_UPDATED" }>,
): Promise<ProcessPaymentEventResult> {
  const storefront = await tx.storefront.findUnique({ where: { stripeAccountId: event.accountId } });
  if (!storefront) return { outcome: "UNKNOWN" };
  if (storefront.payoutsEnabled !== event.payoutsEnabled) {
    await tx.storefront.update({ where: { id: storefront.id }, data: { payoutsEnabled: event.payoutsEnabled } });
    await writeAuditEvent(tx, {
      actorType: "WEBHOOK",
      action: "storefront.payouts_updated",
      subjectType: "Storefront",
      subjectId: storefront.id,
      before: { payoutsEnabled: storefront.payoutsEnabled },
      after: { payoutsEnabled: event.payoutsEnabled },
    });
  }
  return { outcome: "ACCOUNT_UPDATED", storefrontId: storefront.id, payoutsEnabled: event.payoutsEnabled };
}

async function chargeDisputed(
  tx: Tx,
  event: Extract<PaymentEvent, { kind: "CHARGE_DISPUTED" }>,
): Promise<ProcessPaymentEventResult> {
  const payment = await tx.payment.findUnique({ where: { stripeChargeId: event.chargeId }, include: { order: true } });
  if (!payment) return { outcome: "UNKNOWN" };
  const order = payment.order;
  const stillHeld = (HELD_STATUSES as readonly string[]).includes(order.status) && order.status !== "DISPUTED";
  if (stillHeld) await transition(tx, order, "DISPUTE_OPENED");
  else await clawBackOrderEarnings(tx, order.id, "Card chargeback after release");
  const dispute = await tx.dispute.create({
    data: {
      orderId: order.id,
      openedById: order.buyerUserId,
      reason: `Card chargeback: ${event.reason}`,
      isChargeback: true,
      evidenceKeys: [],
    },
  });
  if (!stillHeld) {
    for (const userId of [order.sellerUserId, order.buyerUserId]) await recomputeVolumeBadges(tx, userId);
  }
  await writeAuditEvent(tx, {
    actorType: "WEBHOOK",
    action: stillHeld ? "order.chargeback_opened" : "order.chargeback_after_release",
    subjectType: "Dispute",
    subjectId: dispute.id,
    after: { orderId: order.id, orderStatus: order.status, reason: event.reason },
  });
  return { outcome: "CHARGEBACK", orderId: order.id };
}
