import { z } from "zod";
import { Vertical } from "@/generated/prisma/enums";

const PlatformEnvSchema = z.object({
  ENABLED_VERTICALS: z
    .string()
    .default("ARTIFACT")
    .transform((raw) =>
      raw
        .split(",")
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(Vertical)).min(1)),
  HIGH_VALUE_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(50_000),
  BETA_FOUNDER_LIMIT: z.coerce.number().int().min(0).default(100),
  BADGE_MAX_SALES_PER_COUNTERPARTY: z.coerce.number().int().min(1).default(3),
  /** Off until Kentucky auctioneer licensing (BUILD_PLAN L1) is answered. */
  AUCTIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AUCTION_SOFT_CLOSE_MINUTES: z.coerce.number().int().min(0).max(60).default(2),
  AUCTION_SELLER_DECISION_DAYS: z.coerce.number().int().min(1).max(14).default(3),
});

export interface PlatformConfig {
  enabledVerticals: Vertical[];
  highValueThresholdCents: number;
  betaFounderLimit: number;
  /** Volume badges count at most this many sales to (or purchases from) the same person. */
  badgeMaxSalesPerCounterparty: number;
  auctionsEnabled: boolean;
  /** A bid in the final N minutes pushes the end out to N minutes from the bid (anti-sniping). */
  auctionSoftCloseMinutes: number;
  /** After a winner fails to pay, the seller has this long to pick second chance or relist; then it relists automatically. */
  auctionSellerDecisionDays: number;
}

export function loadPlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const parsed = PlatformEnvSchema.parse(env);
  return {
    enabledVerticals: parsed.ENABLED_VERTICALS,
    highValueThresholdCents: parsed.HIGH_VALUE_THRESHOLD_CENTS,
    betaFounderLimit: parsed.BETA_FOUNDER_LIMIT,
    badgeMaxSalesPerCounterparty: parsed.BADGE_MAX_SALES_PER_COUNTERPARTY,
    auctionsEnabled: parsed.AUCTIONS_ENABLED,
    auctionSoftCloseMinutes: parsed.AUCTION_SOFT_CLOSE_MINUTES,
    auctionSellerDecisionDays: parsed.AUCTION_SELLER_DECISION_DAYS,
  };
}

export const platform: PlatformConfig = loadPlatformConfig();

export function isVerticalEnabled(
  vertical: Vertical,
  config: PlatformConfig = platform,
): boolean {
  return config.enabledVerticals.includes(vertical);
}
