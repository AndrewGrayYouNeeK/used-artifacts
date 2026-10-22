import { Suspense } from "react";
import Link from "next/link";
import { UserIdentity } from "@/components/user-identity";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Suspense fallback={<div className="h-32 animate-pulse rounded-2xl bg-stone-100" />}>
        <AccountDetails />
      </Suspense>
    </div>
  );
}

async function AccountDetails() {
  const user = await requireUser();
  const identity = await getPublicIdentity(db, user.id);

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Your account</p>
      <div className="mt-3">{identity && <UserIdentity identity={identity} size="lg" />}</div>
      <dl className="mt-6 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
        <dt className="text-stone-500">Email</dt>
        <dd>{user.email}</dd>
        <dt className="text-stone-500">Role</dt>
        <dd>{user.role.toLowerCase()}</dd>
      </dl>
      <p className="mt-6 text-sm text-stone-600">
        Need a new password?{" "}
        <Link href="/forgot-password" className="underline">
          Email me a reset link
        </Link>
        .
      </p>
    </div>
  );
}
