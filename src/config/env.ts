import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

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
  cached ??= ServerEnvSchema.parse(process.env);
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
  cachedIdentity ??= IdentityEnvSchema.parse(process.env);
  return cachedIdentity;
}
