import "server-only";
import { identityEnv, serverEnv } from "@/config/env";
import { db } from "@/lib/db";
import { FakeIdentityProvider } from "@/domains/identity/verification/fake-provider";
import type { IdentityProvider } from "@/domains/identity/verification/provider";
import type { VerificationDeps } from "@/domains/identity/verification/verification";
import { StripeIdentityProvider } from "./stripe-identity";

function identityProvider(): IdentityProvider {
  const env = identityEnv();
  const provider = env.IDENTITY_PROVIDER;
  switch (provider) {
    case "stripe":
      return new StripeIdentityProvider(env.STRIPE_SECRET_KEY!, env.STRIPE_IDENTITY_WEBHOOK_SECRET!);
    case "fake":
      return new FakeIdentityProvider(serverEnv().APP_URL);
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown identity provider: ${String(exhaustive)}`);
    }
  }
}

export function verificationDeps(provider: IdentityProvider = identityProvider()): VerificationDeps {
  return {
    db,
    provider,
    fingerprintSecret: identityEnv().IDENTITY_FINGERPRINT_SECRET,
    appUrl: serverEnv().APP_URL,
  };
}

export function usingFakeIdentityProvider(): boolean {
  return process.env.NODE_ENV !== "production" && identityEnv().IDENTITY_PROVIDER === "fake";
}
