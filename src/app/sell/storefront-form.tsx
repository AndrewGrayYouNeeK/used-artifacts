"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/auth";
import { createStorefrontAction } from "@/app/actions/listings";
import { Field, FormMessage, SubmitButton } from "@/components/form";

const initial: FormState = { status: "idle" };

export function StorefrontForm() {
  const [state, action, pending] = useActionState(createStorefrontAction, initial);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  return (
    <form action={action} className="space-y-4">
      <Field label="Store name" name="name" errors={fieldErrors?.name} />
      <Field
        label="Store address"
        name="slug"
        errors={fieldErrors?.slug}
        hint="usedartifacts.com/s/your-address. Lowercase letters, numbers, and dashes."
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Open storefront</SubmitButton>
    </form>
  );
}
