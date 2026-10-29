"use client";

import Link from "next/link";
import { useActionState } from "react";
import { twoFactorLoginAction, type FormState } from "@/app/actions/auth";
import { AuthCard, Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export default function TwoFactorLoginPage() {
  const [state, action, pending] = useActionState(twoFactorLoginAction, initial);

  return (
    <AuthCard title="Enter your code">
      <form action={action} className="space-y-4">
        <p className="text-sm text-stone-600">Open your authenticator app and enter the 6-digit code for Used Artifacts.</p>
        <Field
          label="Authenticator code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          hint="Lost your phone? Enter one of your recovery codes instead (like k7m2p-x9qrt)."
        />
        <FormMessage state={state} />
        <SubmitButton pending={pending}>Verify and sign in</SubmitButton>
        <p className="text-center text-sm text-stone-600">
          <Link href="/login" className="underline">
            Start over
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
