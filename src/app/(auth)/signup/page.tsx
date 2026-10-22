"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signupAction, type FormState } from "@/app/actions/auth";
import { AuthCard, Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, initial);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <AuthCard title="Join the beta">
      {state.status === "success" ? (
        <FormMessage state={state} />
      ) : (
        <form action={action} className="space-y-4">
          <Field label="Display name" name="displayName" autoComplete="nickname" errors={fieldErrors?.displayName} />
          <Field label="Email" name="email" type="email" autoComplete="email" errors={fieldErrors?.email} />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            errors={fieldErrors?.password}
            hint="At least 12 characters."
          />
          <FormMessage state={state} />
          <SubmitButton pending={pending}>Create account</SubmitButton>
          <p className="text-center text-sm text-stone-600">
            Already have an account?{" "}
            <Link href="/login" className="underline">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
