"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/actions/auth";
import { startCheckout } from "@/domains/orders/checkout";
import {
  cancelBySeller,
  confirmReceipt,
  DisputeSchema,
  markShipped,
  openDispute,
  recordDelivery,
  resolveDispute,
  setReleaseHold,
  ShipmentSchema,
} from "@/domains/orders/fulfillment";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { refreshPayoutStatus, startPayoutOnboarding } from "@/domains/payments/payouts";
import { parseUsdToCents } from "@/domains/pricing/pricing";
import { requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { ordersDeps, usingFakePayments } from "@/lib/payments/orders-deps";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function buyNowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const listingId = str(formData, "listingId");
  const result = await startCheckout(
    ordersDeps(),
    { buyerUserId: user.id, buyerEmail: user.email, listingId },
    await requestContext(),
  );
  if (result.ok) redirect(result.url);
  switch (result.reason) {
    case "LISTING_UNAVAILABLE":
      return { status: "error", message: "This item is no longer available." };
    case "SELLER_NOT_READY":
      return { status: "error", message: "The seller hasn't finished setting up payouts yet. Try again later." };
    case "LISTING_RESERVED":
      return { status: "error", message: "Someone else is checking out this item right now. Try again in an hour." };
    case "OWN_LISTING":
      return { status: "error", message: "You can't buy your own item." };
    case "SELF_DEALING":
      return { status: "error", message: "This purchase can't be completed. Contact support if you think this is a mistake." };
    default: {
      const exhaustive: never = result.reason;
      throw new Error(`Unhandled checkout failure: ${String(exhaustive)}`);
    }
  }
}

/** Dev-only stand-in for Stripe Checkout: reports a successful card payment in-process. */
export async function devCompletePaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  if (!usingFakePayments()) return { status: "error", message: "Simulated payments are disabled." };
  const order = await db.order.findUnique({
    where: { id: str(formData, "orderId") },
    include: { payments: { where: { status: "REQUIRES_PAYMENT" }, take: 1 } },
  });
  const payment = order?.payments[0];
  if (!order || order.buyerUserId !== user.id || !payment) return { status: "error", message: "Nothing to pay." };
  const deps = ordersDeps();
  await processPaymentEvent(
    deps,
    fakeCheckoutCompleted({
      checkoutSessionId: payment.checkoutSessionId,
      amountCents: payment.amountCents,
      taxCents: 0,
      shippingAddress: {
        name: str(formData, "name"),
        line1: str(formData, "line1"),
        city: str(formData, "city"),
        state: str(formData, "state").toUpperCase(),
        postalCode: str(formData, "postalCode"),
        country: "US",
      },
      paymentFingerprint: str(formData, "card") || null,
    }),
  );
  redirect(`/orders/${order.id}?paid=1`);
}

export async function markShippedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = ShipmentSchema.safeParse({ carrier: str(formData, "carrier"), trackingNumber: str(formData, "trackingNumber") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the tracking details." };
  const result = await markShipped(
    ordersDeps(),
    { sellerUserId: user.id, orderId: str(formData, "orderId"), ...parsed.data },
    await requestContext(),
  );
  if (!result.ok) return { status: "error", message: "This order can't be marked shipped." };
  revalidatePath("/sell");
  return { status: "success", message: "Marked shipped. The buyer can now track it." };
}

export async function cancelOrderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const result = await cancelBySeller(
    ordersDeps(),
    { sellerUserId: user.id, orderId: str(formData, "orderId"), reason: str(formData, "reason") },
    await requestContext(),
  );
  if (!result.ok) return { status: "error", message: "Only paid orders that haven't shipped can be cancelled." };
  revalidatePath("/sell");
  return { status: "success", message: "Order cancelled. The buyer is refunded in full." };
}

export async function confirmReceiptAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = str(formData, "orderId");
  const result = await confirmReceipt(ordersDeps(), { buyerUserId: user.id, orderId }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "ON_HOLD":
        return { status: "error", message: "This order is under review by our team. We'll be in touch." };
      case "NOT_FOUND":
      case "NOT_CONFIRMABLE":
        return { status: "error", message: "This order can't be confirmed now." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled confirm failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath(`/orders/${orderId}`);
  return { status: "success", message: "Thanks! The seller has been paid." };
}

export async function openDisputeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = str(formData, "orderId");
  const parsed = DisputeSchema.safeParse({ reason: str(formData, "reason") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Describe the problem." };
  const result = await openDispute(ordersDeps(), { buyerUserId: user.id, orderId, ...parsed.data }, await requestContext());
  if (!result.ok) return { status: "error", message: "A problem can only be reported before the seller is paid." };
  revalidatePath(`/orders/${orderId}`);
  return { status: "success", message: "Reported. Funds stay on hold while our team reviews it." };
}

export async function resolveDisputeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const resolution = str(formData, "resolution");
  if (resolution !== "RELEASE" && resolution !== "REFUND" && resolution !== "PARTIAL") {
    return { status: "error", message: "Choose a resolution." };
  }
  const refundCents = resolution === "PARTIAL" ? parseUsdToCents(str(formData, "refund")) : undefined;
  if (resolution === "PARTIAL" && refundCents === null) return { status: "error", message: "Enter the partial refund amount." };
  const result = await resolveDispute(
    ordersDeps(),
    {
      staffUserId: staff.id,
      disputeId: str(formData, "disputeId"),
      resolution,
      refundCents: refundCents ?? undefined,
      notes: str(formData, "notes"),
    },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTES_REQUIRED":
        return { status: "error", message: "Explain the decision in the notes." };
      case "PARTY_TO_ORDER":
        return { status: "error", message: "You're the buyer or seller on this order. Another staff member must decide." };
      case "INVALID_REFUND":
        return { status: "error", message: "A partial refund must be more than $0 and less than the seller's share." };
      case "NOT_STAFF":
      case "NOT_FOUND":
      case "ALREADY_RESOLVED":
        return { status: "error", message: "This dispute is no longer open." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled dispute failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/orders");
  return { status: "success", message: "Dispute resolved." };
}

export async function confirmDeliveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const result = await recordDelivery(ordersDeps(), {
    orderId: str(formData, "orderId"),
    deliveredAt: new Date(),
    source: "STAFF",
    actorUserId: staff.id,
  });
  if (!result.ok) return { status: "error", message: "Only shipped orders can be marked delivered." };
  revalidatePath("/admin/orders");
  return { status: "success", message: `Delivered. Auto-release on ${result.releaseEligibleAt.toISOString().slice(0, 10)}.` };
}

export async function setHoldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const result = await setReleaseHold(
    ordersDeps(),
    {
      staffUserId: staff.id,
      orderId: str(formData, "orderId"),
      hold: str(formData, "hold") === "true",
      reason: str(formData, "reason"),
    },
    await requestContext(),
  );
  if (!result.ok) return { status: "error", message: "Give a reason (at least 5 characters)." };
  revalidatePath("/admin/orders");
  return { status: "success", message: "Saved." };
}

export async function runEscrowJobsAction(): Promise<FormState> {
  await requireStaff();
  const report = await runEscrowJobs(ordersDeps());
  revalidatePath("/admin/orders");
  return {
    status: "success",
    message: `Expired ${report.expired}, cancelled unshipped ${report.cancelledUnshipped}, auto-released ${report.autoReleased}, transfers ${report.transfersPaid}, refunds ${report.refundsSent}.`,
  };
}

export async function startPayoutOnboardingAction(): Promise<FormState> {
  const user = await requireUser();
  const result = await startPayoutOnboarding(ordersDeps(), { userId: user.id, email: user.email });
  if (result.ok) redirect(result.url);
  return { status: "error", message: "Open your storefront (and verify your identity) first." };
}

/** Dev-only stand-in for finishing Stripe Express onboarding. */
export async function devEnablePayoutsAction(): Promise<FormState> {
  const user = await requireUser();
  if (!usingFakePayments()) return { status: "error", message: "Simulated payouts are disabled." };
  const storefront = await db.storefront.findFirst({ where: { ownerUserId: user.id } });
  if (!storefront?.stripeAccountId) return { status: "error", message: "Start payout setup first." };
  await processPaymentEvent(ordersDeps(), {
    eventId: `fake_evt_acct_${storefront.id}_${Date.now()}`,
    kind: "ACCOUNT_UPDATED",
    accountId: storefront.stripeAccountId,
    payoutsEnabled: true,
  });
  redirect("/sell?payouts=1");
}

export async function refreshPayoutsAction(): Promise<void> {
  const user = await requireUser();
  if (!usingFakePayments()) await refreshPayoutStatus(ordersDeps(), user.id);
  redirect("/sell");
}
