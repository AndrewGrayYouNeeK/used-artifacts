import { Suspense } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/form";
import { identityStatusCopy } from "@/components/identity-status";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function VerifyReturnPage() {
  return (
    <AuthCard title="Identity verification">
      <Suspense fallback={<div className="h-24 animate-pulse rounded-lg bg-stone-100" />}>
        <Status />
      </Suspense>
    </AuthCard>
  );
}

async function Status() {
  const user = await requireUser();
  const record = await db.identityVerification.findUnique({
    where: { userId: user.id },
    select: { status: true },
  });
  const status = record?.status ?? null;
  const copy = identityStatusCopy(status);
  const waiting = status === "PENDING" || status === "PROCESSING";
  return (
    <div className="space-y-4 text-sm">
      <p className="font-medium">{waiting ? "Thanks! We're waiting for the result." : copy.label}</p>
      <p className="text-stone-600">
        {waiting
          ? "Results usually arrive within a minute or two. Refresh this page or check your account later."
          : copy.detail}
      </p>
      <div className="flex gap-4">
        <Link href="/account" className="underline">
          Back to my account
        </Link>
        {status === "VERIFIED" && (
          <Link href="/sell" className="underline">
            Start selling
          </Link>
        )}
      </div>
    </div>
  );
}
