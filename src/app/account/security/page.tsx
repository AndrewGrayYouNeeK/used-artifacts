import { Suspense } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { pendingEnrollment, twoFactorStatus } from "@/domains/identity/two-factor";
import { startTwoFactorAction } from "@/app/actions/security";
import { serverEnv } from "@/config/env";
import { platform } from "@/config/platform";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { ConfirmEnrollmentForm, DisableTwoFactorForm, RegenerateCodesForm } from "./security-forms";

export default function SecurityPage({ searchParams }: PageProps<"/account/security">) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/account" className="text-sm text-stone-500 underline">
        ← Account
      </Link>
      <h1 className="mt-4 font-serif text-3xl font-semibold">Sign-in security</h1>
      <Suspense fallback={<div className="mt-6 h-48 animate-pulse rounded-2xl bg-stone-100" />}>
        <SecurityDetails searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SecurityDetails({ searchParams }: { searchParams: PageProps<"/account/security">["searchParams"] }) {
  const user = await requireUser();
  const { required } = await searchParams;
  const isStaff = user.role === "OWNER" || user.role === "MODERATOR";
  const status = await twoFactorStatus(db, user.id);
  const pending = status.enabled ? null : await pendingEnrollment({ db, twoFactorKey: serverEnv().TWO_FACTOR_ENCRYPTION_KEY }, user.id);
  const qrSvg = pending ? await QRCode.toString(pending.otpauthUri, { type: "svg", margin: 1, width: 200 }) : null;
  const needsUpgrade = isStaff && platform.staffTwoFactorRequired && !user.twoFactorVerified;

  return (
    <div className="mt-6 space-y-6">
      {required === "1" && needsUpgrade && (
        <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {status.enabled
            ? "Staff pages need a session opened with your authenticator code. Sign out and sign back in with your code."
            : "Staff pages need two-factor sign-in. Set up an authenticator app below to continue to the dashboard."}
        </p>
      )}
      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold">Authenticator app</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.enabled ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}
          >
            {status.enabled ? "On" : "Off"}
          </span>
        </div>
        {status.enabled ? (
          <div className="mt-4 space-y-6 text-sm">
            <p className="text-stone-600">
              On since {status.enabledAt?.toISOString().slice(0, 10)}. Signing in asks for a code from your app.{" "}
              <strong>{status.recoveryCodesLeft}</strong> unused recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
            </p>
            <RegenerateCodesForm />
            {isStaff && platform.staffTwoFactorRequired ? (
              <p className="text-stone-500">Staff accounts can&apos;t turn two-factor off.</p>
            ) : (
              <DisableTwoFactorForm />
            )}
          </div>
        ) : pending && qrSvg ? (
          <div className="mt-4 space-y-4 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-stone-700">
              <li>Open an authenticator app (1Password, Google Authenticator, Authy, or similar).</li>
              <li>Scan this code, or type the setup key.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div
              role="img"
              aria-label="QR code for your authenticator app"
              className="h-[200px] w-[200px] overflow-hidden rounded-lg border border-stone-200"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p>
              Setup key: <code className="break-all rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs">{pending.secret.match(/.{1,4}/g)?.join(" ")}</code>
            </p>
            <ConfirmEnrollmentForm />
          </div>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <p className="text-stone-600">Add a second step to sign-in so a stolen password alone can&apos;t open your account.</p>
            <form action={startTwoFactorAction}>
              <button type="submit" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
                Set up two-factor sign-in
              </button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
