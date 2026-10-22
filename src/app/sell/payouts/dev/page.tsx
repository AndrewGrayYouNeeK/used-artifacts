import { Suspense } from "react";
import { notFound } from "next/navigation";
import { devEnablePayoutsAction } from "@/app/actions/orders";
import { ActionForm } from "@/components/action-form";
import { AuthCard } from "@/components/form";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { usingFakePayments } from "@/lib/payments/orders-deps";

export default function DevPayoutsPage() {
  return (
    <AuthCard title="Simulated payout setup (dev only)">
      <Suspense fallback={<div className="h-24 animate-pulse rounded-lg bg-stone-100" />}>
        <DevPayouts />
      </Suspense>
    </AuthCard>
  );
}

async function DevPayouts() {
  const user = await requireUser();
  if (!usingFakePayments()) notFound();
  const storefront = await db.storefront.findFirst({ where: { ownerUserId: user.id } });
  if (!storefront?.stripeAccountId) notFound();
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
        Stripe isn&apos;t configured, so this page stands in for Stripe&apos;s Express onboarding (bank
        account, tax details, identity). Finishing it turns payouts on for {storefront.name}.
      </p>
      <ActionForm action={devEnablePayoutsAction} submitLabel="Finish simulated onboarding" />
    </div>
  );
}
