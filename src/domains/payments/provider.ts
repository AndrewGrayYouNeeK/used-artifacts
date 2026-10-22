export class PaymentWebhookSignatureError extends Error {}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface CheckoutLine {
  name: string;
  amountCents: number;
}

export interface CreateCheckoutInput {
  orderId: string;
  lines: CheckoutLine[];
  /** Groups the charge with the seller transfer made on release. */
  transferGroup: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  automaticTax: boolean;
}

export type PaymentEvent =
  | {
      eventId: string;
      kind: "CHECKOUT_COMPLETED";
      checkoutSessionId: string;
      paymentIntentId: string;
      chargeId: string;
      /** Everything the buyer was charged, tax included. */
      amountCents: number;
      taxCents: number;
      shippingAddress: ShippingAddress | null;
      /** Card fingerprint from the processor (raw; hashed before storage). */
      paymentFingerprint: string | null;
    }
  | { eventId: string; kind: "CHECKOUT_EXPIRED"; checkoutSessionId: string }
  | { eventId: string; kind: "ACCOUNT_UPDATED"; accountId: string; payoutsEnabled: boolean }
  | { eventId: string; kind: "CHARGE_DISPUTED"; chargeId: string; reason: string };

export interface PaymentsProvider {
  readonly name: string;
  createConnectedAccount(input: { storefrontId: string; email: string }): Promise<{ accountId: string }>;
  createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string }>;
  getAccountStatus(accountId: string): Promise<{ payoutsEnabled: boolean }>;
  createCheckout(input: CreateCheckoutInput): Promise<{ checkoutSessionId: string; url: string }>;
  /** Best effort: closes an unpaid checkout so it can't be paid later. */
  expireCheckout(checkoutSessionId: string): Promise<void>;
  /** Pays the seller's connected account out of the held charge. */
  createTransfer(input: {
    accountId: string;
    amountCents: number;
    sourceChargeId: string;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<{ transferId: string }>;
  createRefund(input: { chargeId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string }>;
  /** Returns null for event types we don't act on. Throws PaymentWebhookSignatureError. */
  parseWebhook(rawBody: string, signature: string | null): Promise<PaymentEvent | null>;
}
