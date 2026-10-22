import "server-only";
import { serverEnv } from "@/config/env";
import { db } from "@/lib/db";
import { getMailer } from "@/lib/email/mailer";
import type { IdentityDeps } from "@/domains/identity/accounts";

export function identityDeps(): IdentityDeps {
  const env = serverEnv();
  return {
    db,
    mailer: getMailer(),
    appUrl: env.APP_URL,
    twoFactorKey: env.TWO_FACTOR_ENCRYPTION_KEY,
    ownerBootstrapEmail: process.env.PROPRIETOR_EMAIL || undefined,
  };
}
