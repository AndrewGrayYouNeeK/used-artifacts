import { z } from "zod";

/** Basis points: 100 bps = 1%. */
const bps = z.coerce.number().int().min(0).max(10_000);
const cents = z.coerce.number().int().min(0);

const EconomicsEnvSchema = z.object({
  PLATFORM_FEE_BPS_FREE: bps.default(1000),
  PLATFORM_FEE_BPS_PAID: bps.default(500),
  PAID_TIER_PRICE_CENTS: cents.default(2000),
  REFERRAL_BPS: bps.default(500),
  REFERRAL_CAP_AT_PLATFORM_FEE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  ESCROW_AUTO_RELEASE_DAYS: z.coerce.number().int().min(0).default(3),
  AUCTION_PAYMENT_WINDOW_HOURS: z.coerce.number().int().min(1).default(48),
});

export type SellerTier = "FREE" | "PAID";

export interface EconomicsConfig {
  platformFeeBps: Record<SellerTier, number>;
  paidTierPriceCents: number;
  /** Flat share of the sale price on every sale by a recruit, first sale included (owner decision B2). */
  referralBps: number;
  referralCapAtPlatformFee: boolean;
  escrowAutoReleaseDays: number;
  auctionPaymentWindowHours: number;
}

export function loadEconomicsConfig(
  env: Record<string, string | undefined> = process.env,
): EconomicsConfig {
  const parsed = EconomicsEnvSchema.parse(env);
  return {
    platformFeeBps: {
      FREE: parsed.PLATFORM_FEE_BPS_FREE,
      PAID: parsed.PLATFORM_FEE_BPS_PAID,
    },
    paidTierPriceCents: parsed.PAID_TIER_PRICE_CENTS,
    referralBps: parsed.REFERRAL_BPS,
    referralCapAtPlatformFee: parsed.REFERRAL_CAP_AT_PLATFORM_FEE,
    escrowAutoReleaseDays: parsed.ESCROW_AUTO_RELEASE_DAYS,
    auctionPaymentWindowHours: parsed.AUCTION_PAYMENT_WINDOW_HOURS,
  };
}

export const economics: EconomicsConfig = loadEconomicsConfig();

function assertCents(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of cents`);
  }
}

function applyBps(amountCents: number, rateBps: number): number {
  return Math.round((amountCents * rateBps) / 10_000);
}

export function platformFeeCents(
  saleCents: number,
  tier: SellerTier,
  config: EconomicsConfig = economics,
): number {
  assertCents(saleCents, "saleCents");
  return applyBps(saleCents, config.platformFeeBps[tier]);
}

export interface ReferralPayout {
  rateBps: number;
  /** Referral basis is the sale price (owner decision B2). */
  basisCents: number;
  amountCents: number;
  cappedAtFee: boolean;
}

export function referralPayout(
  input: { saleCents: number; platformFeeCents: number },
  config: EconomicsConfig = economics,
): ReferralPayout {
  assertCents(input.saleCents, "saleCents");
  assertCents(input.platformFeeCents, "platformFeeCents");

  const rateBps = config.referralBps;
  const uncapped = applyBps(input.saleCents, rateBps);
  const cappedAtFee =
    config.referralCapAtPlatformFee && uncapped > input.platformFeeCents;
  return {
    rateBps,
    basisCents: input.saleCents,
    amountCents: cappedAtFee ? input.platformFeeCents : uncapped,
    cappedAtFee,
  };
}

export interface SaleSplit {
  saleCents: number;
  platformFeeCents: number;
  referral: ReferralPayout | null;
  /** Platform fee minus referral payout, before payment-processor fees. */
  platformNetCents: number;
  sellerProceedsCents: number;
}

export function splitSale(
  input: { saleCents: number; sellerTier: SellerTier; referred: boolean },
  config: EconomicsConfig = economics,
): SaleSplit {
  const fee = platformFeeCents(input.saleCents, input.sellerTier, config);
  const referral = input.referred
    ? referralPayout({ saleCents: input.saleCents, platformFeeCents: fee }, config)
    : null;
  return {
    saleCents: input.saleCents,
    platformFeeCents: fee,
    referral,
    platformNetCents: fee - (referral?.amountCents ?? 0),
    sellerProceedsCents: input.saleCents - fee,
  };
}
