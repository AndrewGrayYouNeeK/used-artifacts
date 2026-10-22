import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/form";
import { identityStatusCopy } from "@/components/identity-status";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { VerifyForm } from "./verify-form";

export default function VerifyPage() {
  return (
    <AuthCard title="Verify your identity">
      <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-stone-100" />}>
        <VerifyGate />
      </Suspense>
    </AuthCard>
  );
}

async function VerifyGate() {
  const user = await requireUser();
  const record = await db.identityVerification.findUnique({
    where: { userId: user.id },
    select: { status: true },
  });
  const copy = identityStatusCopy(record?.status ?? null);
  if (!copy.canStart) redirect("/account");

  return (
    <div className="space-y-4 text-sm text-stone-700">
      <p>
        Selling on Used Artifacts requires a verified identity, and each person may have only one
        account. Browsing and fixed-price buying don&apos;t need it.
      </p>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Notice and consent (draft – pending lawyer review)
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 text-amber-950">
          <li>
            Our verification partner, Stripe, will ask for a photo of a government-issued ID and a
            live selfie, and will use facial-recognition technology to compare them. This is
            biometric information.
          </li>
          <li>
            Stripe processes and stores the images under its own privacy policy. Used Artifacts never
            receives your ID images or selfie.
          </li>
          <li>
            We receive the result, your legal name, birth year, and document type and country. We keep
            a one-way, keyed fingerprint of your document number and date of birth so the same ID
            can&apos;t open a second account. We never store the document number itself.
          </li>
          <li>Your legal name is used to check your signature on provenance statements.</li>
        </ul>
      </div>
      <VerifyForm />
    </div>
  );
}
