"use client";

import { useActionState } from "react";
import { forgotPasswordAction, type FormState } from "@/app/actions/auth";
import { AuthCard, Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState(forgotPasswordAction, initial);

  return (
    <AuthCard title="Reset your password">
      {state.status === "success" ? (
        <FormMessage state={state} />
      ) : (
        <form action={action} className="space-y-4">
          <p className="text-sm text-stone-600">
            We&apos;ll email a one-time link to your verified address. Only you can set the new
            password; staff can never set or see it.
          </p>
          <Field label="Email" name="email" type="email" autoComplete="email" />
          <FormMessage state={state} />
          <SubmitButton pending={pending}>Email me a reset link</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
