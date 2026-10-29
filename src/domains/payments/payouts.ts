import type { Db } from "@/lib/db";
import { writeAuditEvent } from "@/domains/audit/audit";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import type { PaymentsProvider } from "./provider";

export interface PayoutDeps {
  db: Db;
  payments: PaymentsProvider;
  appUrl: string;
}

export type StartOnboardingResult =
  | { ok: true; url: string }
  | { ok: false; reason: "NO_STOREFRONT" | "NOT_VERIFIED" };

/**
 * Stripe Connect Express onboarding: Stripe collects the seller's bank and
 * tax details (KYC, 1099-K). Listings can't be bought until payouts are on.
 */
export async function startPayoutOnboarding(
  deps: PayoutDeps,
  input: { userId: string; email: string },
): Promise<StartOnboardingResult> {
  const gate = await checkIdentityGate(deps.db, input.userId, "SELL");
  if (!gate.ok) return { ok: false, reason: "NOT_VERIFIED" };
  const storefront = await deps.db.storefront.findFirst({ where: { ownerUserId: input.userId } });
  if (!storefront) return { ok: false, reason: "NO_STOREFRONT" };
  let accountId = storefront.stripeAccountId;
  if (!accountId) {
    const created = await deps.payments.createConnectedAccount({ storefrontId: storefront.id, email: input.email });
    accountId = created.accountId;
    await deps.db.$transaction(async (tx) => {
      await tx.storefront.update({ where: { id: storefront.id }, data: { stripeAccountId: created.accountId } });
      await writeAuditEvent(tx, {
        actorUserId: input.userId,
        actorType: "USER",
        action: "storefront.payout_account_created",
        subjectType: "Storefront",
        subjectId: storefront.id,
        after: { provider: deps.payments.name, accountId: created.accountId },
      });
    });
  }
  const link = await deps.payments.createOnboardingLink({
    accountId,
    returnUrl: `${deps.appUrl}/sell/payouts/return`,
    refreshUrl: `${deps.appUrl}/sell/payouts/refresh`,
  });
  return { ok: true, url: link.url };
}

/** Pulls the account's current state (the account.updated webhook does the same). */
export async function refreshPayoutStatus(deps: PayoutDeps, userId: string): Promise<boolean | null> {
  const storefront = await deps.db.storefront.findFirst({ where: { ownerUserId: userId } });
  if (!storefront?.stripeAccountId) return null;
  const { payoutsEnabled } = await deps.payments.getAccountStatus(storefront.stripeAccountId);
  if (payoutsEnabled !== storefront.payoutsEnabled) {
    await deps.db.$transaction(async (tx) => {
      await tx.storefront.update({ where: { id: storefront.id }, data: { payoutsEnabled } });
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "storefront.payouts_updated",
        subjectType: "Storefront",
        subjectId: storefront.id,
        before: { payoutsEnabled: storefront.payoutsEnabled },
        after: { payoutsEnabled },
      });
    });
  }
  return payoutsEnabled;
}
