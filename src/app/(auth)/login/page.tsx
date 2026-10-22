"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type FormState } from "@/app/actions/auth";
import { AuthCard, Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial);

  return (
    <AuthCard title="Sign in">
      <form action={action} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <FormMessage state={state} />
        <SubmitButton pending={pending}>Sign in</SubmitButton>
        <div className="flex justify-between text-sm text-stone-600">
          <Link href="/forgot-password" className="underline">
            Forgot password?
          </Link>
          <Link href="/signup" className="underline">
            Create an account
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}
