"use client";

import Link from "next/link";
import { useActionState } from "react";
import { verifyEmailAction, type FormState } from "@/app/actions/auth";
import { FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(verifyEmailAction, initial);

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
      <p className="text-sm text-stone-600">Confirm that this email address belongs to you.</p>
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Confirm my email</SubmitButton>
    </form>
  );
}
