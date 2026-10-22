import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

/** Empty variables (as copied from .env.example) count as unset. */
function envSource(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""),
  );
}

const devDefault = (value: string) => (isProduction ? z.string().min(32) : z.string().min(32).default(value));

const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.url().default("http://localhost:3000"),
  /** HMAC key for hashing IP addresses and user agents before storage. */
  IP_HASH_SECRET: devDefault("dev-only-ip-hash-secret-change-me-0000000000"),
  EMAIL_FROM: z.string().default("Used Artifacts <no-reply@usedartifacts.com>"),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= ServerEnvSchema.parse(envSource());
  return cached;
}

/**
 * Validated separately so a missing Stripe key only breaks identity
 * verification, not sign-in.
 */
const IdentityEnvSchema = z
  .object({
    /** `fake` simulates verification locally and is refused in production. */
    IDENTITY_PROVIDER: z.enum(["stripe", "fake"]).optional(),
    /** HMAC key for ID document and person fingerprints. Rotating it breaks duplicate detection. */
    IDENTITY_FINGERPRINT_SECRET: devDefault("dev-only-identity-fingerprint-secret-0000000"),
    /** Restricted key with Identity write access and sensitive verification-result access. */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_IDENTITY_WEBHOOK_SECRET: z.string().min(1).optional(),
  })
  .transform((env) => ({
    ...env,
    IDENTITY_PROVIDER:
      env.IDENTITY_PROVIDER ?? (env.STRIPE_SECRET_KEY || isProduction ? "stripe" : "fake"),
  }))
  .superRefine((env, ctx) => {
    if (env.IDENTITY_PROVIDER === "fake" && isProduction) {
      ctx.addIssue({ code: "custom", message: "IDENTITY_PROVIDER=fake is not allowed in production." });
    }
    if (
      env.IDENTITY_PROVIDER === "stripe" &&
      (!env.STRIPE_SECRET_KEY || !env.STRIPE_IDENTITY_WEBHOOK_SECRET)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Stripe Identity needs STRIPE_SECRET_KEY and STRIPE_IDENTITY_WEBHOOK_SECRET.",
      });
    }
  });

export type IdentityEnv = z.infer<typeof IdentityEnvSchema>;

let cachedIdentity: IdentityEnv | undefined;

export function identityEnv(): IdentityEnv {
  cachedIdentity ??= IdentityEnvSchema.parse(envSource());
  return cachedIdentity;
}

/** Stripe Connect (Express) for checkout, held funds, transfers, and refunds. */
const PaymentsEnvSchema = z
  .object({
    /** `fake` simulates checkout and onboarding locally and is refused in production. */
    PAYMENTS_PROVIDER: z.enum(["stripe", "fake"]).optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    /** Signing secret of /api/webhooks/stripe (platform + Connect events). */
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    /** Stripe Tax computes marketplace-facilitator sales tax at checkout once registrations exist. */
    STRIPE_AUTOMATIC_TAX: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** HMAC key for card-fingerprint and address linkage hashes. */
    LINKAGE_HASH_SECRET: devDefault("dev-only-linkage-hash-secret-change-me-00000"),
  })
  .transform((env) => ({
    ...env,
    PAYMENTS_PROVIDER: env.PAYMENTS_PROVIDER ?? (env.STRIPE_SECRET_KEY || isProduction ? "stripe" : "fake"),
  }))
  .superRefine((env, ctx) => {
    if (env.PAYMENTS_PROVIDER === "fake" && isProduction) {
      ctx.addIssue({ code: "custom", message: "PAYMENTS_PROVIDER=fake is not allowed in production." });
    }
    if (env.PAYMENTS_PROVIDER === "stripe" && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: "custom", message: "Stripe Connect needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET." });
    }
  });

export type PaymentsEnv = z.infer<typeof PaymentsEnvSchema>;

let cachedPayments: PaymentsEnv | undefined;

export function paymentsEnv(): PaymentsEnv {
  cachedPayments ??= PaymentsEnvSchema.parse(envSource());
  return cachedPayments;
}

/** Listing photos. Local disk is for development only (serverless disks are ephemeral). */
const StorageEnvSchema = z
  .object({
    STORAGE_DRIVER: z.enum(["local", "s3"]).default(isProduction ? "s3" : "local"),
    LOCAL_STORAGE_DIR: z.string().default(".data/uploads"),
    /** S3 or Cloudflare R2 (set S3_ENDPOINT to the R2 endpoint and S3_REGION=auto). */
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().default("auto"),
    S3_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Public CDN base for the photo bucket, e.g. https://photos.usedartifacts.com */
    STORAGE_PUBLIC_BASE_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "local" && isProduction) {
      ctx.addIssue({ code: "custom", message: "STORAGE_DRIVER=local is not allowed in production." });
    }
    if (
      env.STORAGE_DRIVER === "s3" &&
      (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.STORAGE_PUBLIC_BASE_URL)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "S3/R2 storage needs S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and STORAGE_PUBLIC_BASE_URL.",
      });
    }
  });

export type StorageEnv = z.infer<typeof StorageEnvSchema>;

let cachedStorage: StorageEnv | undefined;

export function storageEnv(): StorageEnv {
  cachedStorage ??= StorageEnvSchema.parse(envSource());
  return cachedStorage;
}

/** Carrier tracking. `manual` means staff or the buyer confirm delivery. */
const ShippingEnvSchema = z
  .object({
    SHIPPING_TRACKER: z.enum(["manual", "easypost"]).default("manual"),
    EASYPOST_API_KEY: z.string().min(1).optional(),
    EASYPOST_WEBHOOK_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SHIPPING_TRACKER === "easypost" && (!env.EASYPOST_API_KEY || !env.EASYPOST_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: "custom", message: "EasyPost tracking needs EASYPOST_API_KEY and EASYPOST_WEBHOOK_SECRET." });
    }
  });

export type ShippingEnv = z.infer<typeof ShippingEnvSchema>;

let cachedShipping: ShippingEnv | undefined;

export function shippingEnv(): ShippingEnv {
  cachedShipping ??= ShippingEnvSchema.parse(envSource());
  return cachedShipping;
}

/** Vision model for the photo analyzer (BUILD_PLAN 3.5). */
const AiEnvSchema = z
  .object({
    /** `fake` returns canned suggestions locally and is refused in production. */
    AI_VISION_PROVIDER: z.enum(["anthropic", "fake"]).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_VISION_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  })
  .transform((env) => ({
    ...env,
    AI_VISION_PROVIDER: env.AI_VISION_PROVIDER ?? (env.ANTHROPIC_API_KEY || isProduction ? "anthropic" : "fake"),
  }))
  .superRefine((env, ctx) => {
    if (env.AI_VISION_PROVIDER === "fake" && isProduction) {
      ctx.addIssue({ code: "custom", message: "AI_VISION_PROVIDER=fake is not allowed in production." });
    }
    if (env.AI_VISION_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", message: "The photo analyzer needs ANTHROPIC_API_KEY." });
    }
  });

export type AiEnv = z.infer<typeof AiEnvSchema>;

let cachedAi: AiEnv | undefined;

export function aiEnv(): AiEnv {
  cachedAi ??= AiEnvSchema.parse(envSource());
  return cachedAi;
}

/** Bearer token the scheduler sends to /api/cron/* (Vercel Cron sends CRON_SECRET automatically). */
export function cronSecret(): string {
  return devDefault("dev-only-cron-secret-change-me-0000000000000").parse(envSource().CRON_SECRET);
}
