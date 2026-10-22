import { z } from "zod";
import {
  applyBps,
  assertCents,
  priceBreakdown,
  type FeeRates,
  type PriceBreakdown,
} from "@/domains/pricing/pricing";

/** Basis points: 100 bps = 1%. */
const bps = z.coerce.number().int().min(0).max(10_000);

export const REFERRAL_BASES = ["BUYER_PRICE", "ASKING_PRICE"] as const;
export type ReferralBasis = (typeof REFERRAL_BASES)[number];

const EconomicsEnvSchema = z.object({
  BUYER_FEE_BPS: bps.default(1000),
  SELLER_FEE_BPS: bps.default(1000),
  REFERRAL_BPS: bps.default(500),
  REFERRAL_BASIS: z.enum(REFERRAL_BASES).default("BUYER_PRICE"),
  REFERRAL_CAP_AT_PLATFORM_FEE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  ESCROW_AUTO_RELEASE_DAYS: z.coerce.number().int().min(0).default(3),
  SELLER_SHIP_BY_DAYS: z.coerce.number().int().min(1).default(5),
  CHECKOUT_HOLD_MINUTES: z.coerce.number().int().min(30).max(1440).default(60),
  AUCTION_PAYMENT_WINDOW_HOURS: z.coerce.number().int().min(1).default(48),
});

export interface EconomicsConfig extends FeeRates {
  /** Flat share of the sale on every sale by a recruit, first sale included (owner decision B2). */
  referralBps: number;
  /** Which amount "5% of the sale" is computed on. Pending Andrew's confirmation (BUILD_PLAN 0.2). */
  referralBasis: ReferralBasis;
  referralCapAtPlatformFee: boolean;
  escrowAutoReleaseDays: number;
  /** Paid orders not marked shipped within this many days are cancelled and refunded. */
  sellerShipByDays: number;
  /** How long an unpaid checkout holds the listing (Stripe Checkout needs at least 30). */
  checkoutHoldMinutes: number;
  auctionPaymentWindowHours: number;
}

export function loadEconomicsConfig(
  env: Record<string, string | undefined> = process.env,
): EconomicsConfig {
  const parsed = EconomicsEnvSchema.parse(env);
  return {
    buyerFeeBps: parsed.BUYER_FEE_BPS,
    sellerFeeBps: parsed.SELLER_FEE_BPS,
    referralBps: parsed.REFERRAL_BPS,
    referralBasis: parsed.REFERRAL_BASIS,
    referralCapAtPlatformFee: parsed.REFERRAL_CAP_AT_PLATFORM_FEE,
    escrowAutoReleaseDays: parsed.ESCROW_AUTO_RELEASE_DAYS,
    sellerShipByDays: parsed.SELLER_SHIP_BY_DAYS,
    checkoutHoldMinutes: parsed.CHECKOUT_HOLD_MINUTES,
    auctionPaymentWindowHours: parsed.AUCTION_PAYMENT_WINDOW_HOURS,
  };
}

export const economics: EconomicsConfig = loadEconomicsConfig();

export function feeRates(config: EconomicsConfig = economics): FeeRates {
  return { buyerFeeBps: config.buyerFeeBps, sellerFeeBps: config.sellerFeeBps };
}

export interface ReferralPayout {
  rateBps: number;
  basis: ReferralBasis;
  basisCents: number;
  amountCents: number;
  cappedAtFee: boolean;
}

export function referralPayout(
  prices: PriceBreakdown,
  config: EconomicsConfig = economics,
): ReferralPayout {
  let basisCents: number;
  switch (config.referralBasis) {
    case "BUYER_PRICE":
      basisCents = prices.buyerPriceCents;
      break;
    case "ASKING_PRICE":
      basisCents = prices.askingCents;
      break;
    default: {
      const exhaustive: never = config.referralBasis;
      throw new Error(`Unknown referral basis: ${String(exhaustive)}`);
    }
  }
  assertCents(basisCents, "basisCents");
  const uncapped = applyBps(basisCents, config.referralBps);
  const cappedAtFee = config.referralCapAtPlatformFee && uncapped > prices.platformFeeCents;
  return {
    rateBps: config.referralBps,
    basis: config.referralBasis,
    basisCents,
    amountCents: cappedAtFee ? prices.platformFeeCents : uncapped,
    cappedAtFee,
  };
}

export interface SaleSplit extends PriceBreakdown {
  referral: ReferralPayout | null;
  /** Buyer fee + seller fee − referral payout, before payment-processor fees. */
  platformNetCents: number;
}

export function splitSale(
  input: { askingCents: number; referred: boolean },
  config: EconomicsConfig = economics,
): SaleSplit {
  const prices = priceBreakdown(input.askingCents, feeRates(config));
  const referral = input.referred ? referralPayout(prices, config) : null;
  return {
    ...prices,
    referral,
    platformNetCents: prices.platformFeeCents - (referral?.amountCents ?? 0),
  };
}
