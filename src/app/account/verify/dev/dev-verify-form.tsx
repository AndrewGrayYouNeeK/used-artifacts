"use client";

import { useActionState } from "react";
import { devCompleteVerificationAction } from "@/app/actions/identity";
import type { FormState } from "@/app/actions/auth";
import { Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export function DevVerifyForm({ session }: { session: string }) {
  const [state, action, pending] = useActionState(devCompleteVerificationAction, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="session" value={session} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" name="firstName" />
        <Field label="Last name" name="lastName" />
      </div>
      <Field label="Date of birth" name="dob" type="date" />
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field label="Document number" name="documentNumber" />
        <Field label="Country" name="issuingCountry" hint="e.g. US" />
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-stone-800">Outcome</span>
        <select name="outcome" className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm">
          <option value="VERIFIED">Verified</option>
          <option value="REQUIRES_INPUT">Requires input (blurry photo)</option>
          <option value="CANCELED">Canceled</option>
        </select>
      </label>
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Submit simulated result</SubmitButton>
    </form>
  );
}
