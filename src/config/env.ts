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
