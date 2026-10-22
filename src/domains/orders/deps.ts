import type { Db } from "@/lib/db";
import { economics, type EconomicsConfig } from "@/config/economics";
import { platform, type PlatformConfig } from "@/config/platform";
import type { PaymentsProvider } from "@/domains/payments/provider";

export interface ShippingTracker {
  readonly name: string;
  /** Starts carrier tracking; delivered events arrive by webhook. Null id = no automatic tracking. */
  register(input: { carrier: string; trackingNumber: string }): Promise<{ trackerId: string | null }>;
}

export const manualTracker: ShippingTracker = {
  name: "manual",
  register: async () => ({ trackerId: null }),
};

export interface OrdersDeps {
  db: Db;
  payments: PaymentsProvider;
  appUrl: string;
  /** HMAC key for card-fingerprint and address hashes. */
  linkageSecret: string;
  automaticTax?: boolean;
  tracker?: ShippingTracker;
  economics?: EconomicsConfig;
  platform?: PlatformConfig;
  now?: () => Date;
}

export const clock = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
export const econ = (deps: OrdersDeps) => deps.economics ?? economics;
export const platformConfig = (deps: OrdersDeps) => deps.platform ?? platform;

export const DAY_MS = 24 * 60 * 60 * 1000;
