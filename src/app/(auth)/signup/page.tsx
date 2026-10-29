import { Suspense } from "react";
import { findReferrer, normalizeReferralCode } from "@/domains/growth/referrals";
import { platform } from "@/config/platform";
import { db } from "@/lib/db";
import { SignupForm } from "./signup-form";

export default function SignupPage({ searchParams }: PageProps<"/signup">) {
  return (
    <Suspense fallback={<SignupForm referral={null} invite="" inviteRequired={platform.betaInviteRequired} />}>
      <SignupWithReferral searchParams={searchParams} />
    </Suspense>
  );
}

async function SignupWithReferral({ searchParams }: { searchParams: PageProps<"/signup">["searchParams"] }) {
  const { ref, invite } = await searchParams;
  const code = typeof ref === "string" ? normalizeReferralCode(ref) : "";
  const referrer = code ? await findReferrer(db, code) : null;
  return (
    <SignupForm
      referral={referrer ? { code, referrerName: referrer.displayName } : null}
      invite={typeof invite === "string" ? invite.slice(0, 64) : ""}
      inviteRequired={platform.betaInviteRequired}
    />
  );
}
