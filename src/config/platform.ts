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
  /** Off until Kentucky auctioneer licensing (BUILD_PLAN L1) is answered. */
  AUCTIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export interface PlatformConfig {
  enabledVerticals: Vertical[];
  highValueThresholdCents: number;
  betaFounderLimit: number;
  auctionsEnabled: boolean;
}

export function loadPlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const parsed = PlatformEnvSchema.parse(env);
  return {
    enabledVerticals: parsed.ENABLED_VERTICALS,
    highValueThresholdCents: parsed.HIGH_VALUE_THRESHOLD_CENTS,
    betaFounderLimit: parsed.BETA_FOUNDER_LIMIT,
    auctionsEnabled: parsed.AUCTIONS_ENABLED,
  };
}

export const platform: PlatformConfig = loadPlatformConfig();

export function isVerticalEnabled(
  vertical: Vertical,
  config: PlatformConfig = platform,
): boolean {
  return config.enabledVerticals.includes(vertical);
}
