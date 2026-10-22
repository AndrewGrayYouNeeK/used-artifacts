"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordAction, type FormState } from "@/app/actions/auth";
import { Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, initial);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <FormMessage state={state} />
        <Link href="/login" className="block text-center text-sm underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        errors={fieldErrors?.password}
        hint="At least 12 characters."
      />
      <Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" />
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Set new password</SubmitButton>
    </form>
  );
}
