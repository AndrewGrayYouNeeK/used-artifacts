import "server-only";
import Stripe from "stripe";
import {
  PaymentWebhookSignatureError,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentsProvider,
  type ShippingAddress,
} from "@/domains/payments/provider";

/**
 * Stripe Connect (Express) with separate charges and transfers: the platform
 * charges the buyer and holds the funds; the seller's share is transferred
 * from that charge (source_transaction) only when the order releases.
 */
export class StripeConnectProvider implements PaymentsProvider {
  readonly name = "stripe";
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createConnectedAccount(input: { storefrontId: string; email: string }) {
    const account = await this.stripe.accounts.create({
      type: "express",
      country: "US",
      email: input.email,
      capabilities: { transfers: { requested: true } },
      metadata: { storefrontId: input.storefrontId },
    });
    return { accountId: account.id };
  }

  async createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }) {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      return_url: input.returnUrl,
      refresh_url: input.refreshUrl,
      type: "account_onboarding",
    });
    return { url: link.url };
  }

  async getAccountStatus(accountId: string) {
    const account = await this.stripe.accounts.retrieve(accountId);
    return { payoutsEnabled: Boolean(account.payouts_enabled) };
  }

  async createCheckout(input: CreateCheckoutInput) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: input.orderId,
      customer_email: input.customerEmail,
      line_items: input.lines.map((line) => ({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: line.amountCents, product_data: { name: line.name } },
      })),
      payment_intent_data: { transfer_group: input.transferGroup, metadata: { orderId: input.orderId } },
      shipping_address_collection: { allowed_countries: ["US"] },
      automatic_tax: { enabled: input.automaticTax },
      expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      metadata: { orderId: input.orderId },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { checkoutSessionId: session.id, url: session.url };
  }

  async expireCheckout(checkoutSessionId: string) {
    await this.stripe.checkout.sessions.expire(checkoutSessionId);
  }

  async createTransfer(input: {
    accountId: string;
    amountCents: number;
    sourceChargeId: string;
    transferGroup: string;
    idempotencyKey: string;
  }) {
    const transfer = await this.stripe.transfers.create(
      {
        amount: input.amountCents,
        currency: "usd",
        destination: input.accountId,
        source_transaction: input.sourceChargeId,
        transfer_group: input.transferGroup,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { transferId: transfer.id };
  }

  async createRefund(input: { chargeId: string; amountCents: number; idempotencyKey: string }) {
    const refund = await this.stripe.refunds.create(
      { charge: input.chargeId, amount: input.amountCents },
      { idempotencyKey: input.idempotencyKey },
    );
    return { refundId: refund.id };
  }

  async parseWebhook(rawBody: string, signature: string | null): Promise<PaymentEvent | null> {
    if (!signature) throw new PaymentWebhookSignatureError("Missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new PaymentWebhookSignatureError(err instanceof Error ? err.message : "Invalid signature");
    }
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.payment_status !== "paid" || !session.payment_intent) return null;
        const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
        const pi = await this.stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
        const charge = pi.latest_charge && typeof pi.latest_charge !== "string" ? pi.latest_charge : null;
        if (!charge) throw new Error(`Payment intent ${piId} has no charge`);
        const shipping = session.collected_information?.shipping_details ?? null;
        const address: ShippingAddress | null =
          shipping?.address.line1 && shipping.address.city && shipping.address.state && shipping.address.postal_code
            ? {
                name: shipping.name,
                line1: shipping.address.line1,
                line2: shipping.address.line2,
                city: shipping.address.city,
                state: shipping.address.state,
                postalCode: shipping.address.postal_code,
                country: shipping.address.country ?? "US",
              }
            : null;
        return {
          eventId: event.id,
          kind: "CHECKOUT_COMPLETED",
          checkoutSessionId: session.id,
          paymentIntentId: piId,
          chargeId: charge.id,
          amountCents: session.amount_total ?? charge.amount,
          taxCents: session.total_details?.amount_tax ?? 0,
          shippingAddress: address,
          paymentFingerprint: charge.payment_method_details?.card?.fingerprint ?? null,
        };
      }
      case "checkout.session.expired":
        return { eventId: event.id, kind: "CHECKOUT_EXPIRED", checkoutSessionId: event.data.object.id };
      case "account.updated":
        return {
          eventId: event.id,
          kind: "ACCOUNT_UPDATED",
          accountId: event.data.object.id,
          payoutsEnabled: Boolean(event.data.object.payouts_enabled),
        };
      case "charge.dispute.created": {
        const dispute = event.data.object;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
        return { eventId: event.id, kind: "CHARGE_DISPUTED", chargeId, reason: dispute.reason };
      }
      default:
        return null;
    }
  }
}
