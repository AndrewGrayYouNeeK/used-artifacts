import { Suspense } from "react";
import { findReferrer, normalizeReferralCode } from "@/domains/growth/referrals";
import { db } from "@/lib/db";
import { SignupForm } from "./signup-form";

export default function SignupPage({ searchParams }: PageProps<"/signup">) {
  return (
    <Suspense fallback={<SignupForm referral={null} />}>
      <SignupWithReferral searchParams={searchParams} />
    </Suspense>
  );
}

async function SignupWithReferral({ searchParams }: { searchParams: PageProps<"/signup">["searchParams"] }) {
  const { ref } = await searchParams;
  const code = typeof ref === "string" ? normalizeReferralCode(ref) : "";
  const referrer = code ? await findReferrer(db, code) : null;
  return <SignupForm referral={referrer ? { code, referrerName: referrer.displayName } : null} />;
}
