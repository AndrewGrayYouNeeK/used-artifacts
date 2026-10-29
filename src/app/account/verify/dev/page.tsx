import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AuthCard } from "@/components/form";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { usingFakeIdentityProvider } from "@/lib/identity/verification-deps";
import { DevVerifyForm } from "./dev-verify-form";

export default function DevVerifyPage({ searchParams }: PageProps<"/account/verify/dev">) {
  return (
    <AuthCard title="Simulated ID check (dev only)">
      <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-stone-100" />}>
        <DevGate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function DevGate({ searchParams }: { searchParams: PageProps<"/account/verify/dev">["searchParams"] }) {
  const { session } = await searchParams;
  const user = await requireUser();
  if (!usingFakeIdentityProvider()) notFound();
  const record = await db.identityVerification.findUnique({ where: { userId: user.id } });
  if (typeof session !== "string" || record?.providerSessionId !== session) notFound();
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
        Stripe Identity isn&apos;t configured, so this page stands in for it. Type the details a real
        document would show. Reusing a document number from another account triggers duplicate
        detection.
      </p>
      <DevVerifyForm session={session} />
    </div>
  );
}
