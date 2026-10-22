import "server-only";
import { paymentsEnv, serverEnv, shippingEnv } from "@/config/env";
import { db } from "@/lib/db";
import { FakePaymentsProvider } from "@/domains/payments/fake-provider";
import type { PaymentsProvider } from "@/domains/payments/provider";
import { manualTracker, type OrdersDeps, type ShippingTracker } from "@/domains/orders/deps";
import { EasyPostTracker } from "@/lib/shipping/easypost";
import { StripeConnectProvider } from "./stripe-connect";

const globalForPayments = globalThis as unknown as { fakePayments?: FakePaymentsProvider };

function paymentsProvider(): PaymentsProvider {
  const env = paymentsEnv();
  const provider = env.PAYMENTS_PROVIDER;
  switch (provider) {
    case "stripe":
      return new StripeConnectProvider(env.STRIPE_SECRET_KEY!, env.STRIPE_WEBHOOK_SECRET!);
    case "fake":
      globalForPayments.fakePayments ??= new FakePaymentsProvider(serverEnv().APP_URL);
      return globalForPayments.fakePayments;
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown payments provider: ${String(exhaustive)}`);
    }
  }
}

function shippingTracker(): ShippingTracker {
  const env = shippingEnv();
  const tracker = env.SHIPPING_TRACKER;
  switch (tracker) {
    case "easypost":
      return new EasyPostTracker(env.EASYPOST_API_KEY!);
    case "manual":
      return manualTracker;
    default: {
      const exhaustive: never = tracker;
      throw new Error(`Unknown shipping tracker: ${String(exhaustive)}`);
    }
  }
}

export function ordersDeps(): OrdersDeps {
  const env = paymentsEnv();
  return {
    db,
    payments: paymentsProvider(),
    appUrl: serverEnv().APP_URL,
    linkageSecret: env.LINKAGE_HASH_SECRET,
    automaticTax: env.STRIPE_AUTOMATIC_TAX,
    tracker: shippingTracker(),
  };
}

export function usingFakePayments(): boolean {
  return process.env.NODE_ENV !== "production" && paymentsEnv().PAYMENTS_PROVIDER === "fake";
}
