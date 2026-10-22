"use client";

import { useActionState } from "react";
import { startVerificationAction } from "@/app/actions/identity";
import type { FormState } from "@/app/actions/auth";
import { FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export function VerifyForm() {
  const [state, action, pending] = useActionState(startVerificationAction, initial);
  return (
    <form action={action} className="space-y-4">
      <label className="flex items-start gap-3">
        <input type="checkbox" name="consent" required className="mt-0.5 h-4 w-4 rounded border-stone-300" />
        <span>
          I have read the notice above and consent to the collection and use of my ID images and
          biometric data for identity verification.
        </span>
      </label>
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Continue to verification</SubmitButton>
    </form>
  );
}
