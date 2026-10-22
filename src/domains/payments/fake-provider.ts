import { randomUUID } from "node:crypto";
import {
  PaymentWebhookSignatureError,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentsProvider,
} from "./provider";

/**
 * Local stand-in for Stripe Connect (dev and tests). Checkout and onboarding
 * open dev pages that report outcomes in-process; production refuses this
 * provider (see paymentsEnv).
 */
export class FakePaymentsProvider implements PaymentsProvider {
  readonly name = "fake";
  readonly transfers: { idempotencyKey: string; accountId: string; amountCents: number; transferId: string }[] = [];
  readonly refunds: { idempotencyKey: string; chargeId: string; amountCents: number; refundId: string }[] = [];
  failTransfers = false;
  failRefunds = false;

  constructor(private readonly appUrl: string) {}

  async createConnectedAccount(input: { storefrontId: string }) {
    return { accountId: `fake_acct_${input.storefrontId}` };
  }

  async createOnboardingLink(input: { accountId: string }) {
    return { url: `${this.appUrl}/sell/payouts/dev?account=${encodeURIComponent(input.accountId)}` };
  }

  async getAccountStatus() {
    return { payoutsEnabled: false };
  }

  async createCheckout(input: CreateCheckoutInput) {
    const checkoutSessionId = `fake_cs_${randomUUID()}`;
    return { checkoutSessionId, url: `${this.appUrl}/checkout/dev/${encodeURIComponent(input.orderId)}` };
  }

  async expireCheckout() {}

  async createTransfer(input: { accountId: string; amountCents: number; idempotencyKey: string }) {
    if (this.failTransfers) throw new Error("Simulated transfer failure");
    const existing = this.transfers.find((t) => t.idempotencyKey === input.idempotencyKey);
    if (existing) return { transferId: existing.transferId };
    const transferId = `fake_tr_${randomUUID()}`;
    this.transfers.push({ ...input, transferId });
    return { transferId };
  }

  async createRefund(input: { chargeId: string; amountCents: number; idempotencyKey: string }) {
    if (this.failRefunds) throw new Error("Simulated refund failure");
    const existing = this.refunds.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) return { refundId: existing.refundId };
    const refundId = `fake_re_${randomUUID()}`;
    this.refunds.push({ ...input, refundId });
    return { refundId };
  }

  async parseWebhook(): Promise<PaymentEvent | null> {
    throw new PaymentWebhookSignatureError("The fake payments provider does not accept webhooks.");
  }
}

export function fakeCheckoutCompleted(
  input: Omit<Extract<PaymentEvent, { kind: "CHECKOUT_COMPLETED" }>, "eventId" | "kind" | "paymentIntentId" | "chargeId">,
): Extract<PaymentEvent, { kind: "CHECKOUT_COMPLETED" }> {
  return {
    eventId: `fake_evt_${randomUUID()}`,
    kind: "CHECKOUT_COMPLETED",
    paymentIntentId: `fake_pi_${randomUUID()}`,
    chargeId: `fake_ch_${randomUUID()}`,
    ...input,
  };
}
