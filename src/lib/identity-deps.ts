import "server-only";
import { serverEnv } from "@/config/env";
import { db } from "@/lib/db";
import { getMailer } from "@/lib/email/mailer";
import type { IdentityDeps } from "@/domains/identity/accounts";

export function identityDeps(): IdentityDeps {
  return { db, mailer: getMailer(), appUrl: serverEnv().APP_URL };
}
