"use client";

import { useActionState } from "react";
import { submitFeedbackAction } from "@/app/actions/beta";
import type { FormState } from "@/app/actions/auth";
import { inputClass } from "@/components/action-form";
import { FormMessage, SubmitButton } from "@/components/form";
import { FEEDBACK_CATEGORIES } from "@/domains/admin/feedback-categories";

const initial: FormState = { status: "idle" };

export function FeedbackForm({ from }: { from: string }) {
  const [state, action, pending] = useActionState(submitFeedbackAction, initial);
  if (state.status === "success") {
    return (
      <div className="mt-6">
        <FormMessage state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="mt-6 space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">What&apos;s this about?</span>
        <select name="category" required defaultValue="BUG" className={inputClass}>
          {FEEDBACK_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Page</span>
        <input name="pagePath" defaultValue={from} placeholder="/listings/…" className={inputClass} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Message</span>
        <textarea name="message" required minLength={5} maxLength={5000} rows={6} className={inputClass} />
      </label>
      <FormMessage state={state} />
      <SubmitButton pending={pending}>Send feedback</SubmitButton>
    </form>
  );
}
