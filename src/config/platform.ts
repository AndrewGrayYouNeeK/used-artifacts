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
});

export interface PlatformConfig {
  enabledVerticals: Vertical[];
  highValueThresholdCents: number;
  betaFounderLimit: number;
}

export function loadPlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const parsed = PlatformEnvSchema.parse(env);
  return {
    enabledVerticals: parsed.ENABLED_VERTICALS,
    highValueThresholdCents: parsed.HIGH_VALUE_THRESHOLD_CENTS,
    betaFounderLimit: parsed.BETA_FOUNDER_LIMIT,
  };
}

export const platform: PlatformConfig = loadPlatformConfig();

export function isVerticalEnabled(
  vertical: Vertical,
  config: PlatformConfig = platform,
): boolean {
  return config.enabledVerticals.includes(vertical);
}
