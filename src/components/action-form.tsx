"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/auth";
import { FormMessage } from "@/components/form";

const initial: FormState = { status: "idle" };

const VARIANTS = {
  primary: "bg-stone-900 text-white hover:bg-stone-700",
  secondary: "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50",
  danger: "border border-red-300 bg-white text-red-800 hover:bg-red-50",
} as const;

/** A small form bound to a server action, with inline success/error feedback. */
export function ActionForm({
  action,
  submitLabel,
  variant = "primary",
  confirm,
  className = "space-y-3",
  children,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  variant?: keyof typeof VARIANTS;
  /** Asks before submitting (irreversible money movements). */
  confirm?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <button
        type="submit"
        disabled={pending}
        className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60 ${VARIANTS[variant]}`}
      >
        {pending ? "Working…" : submitLabel}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";
