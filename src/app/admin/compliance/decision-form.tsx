"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/auth";
import { reviewIdentityAction } from "@/app/actions/identity";
import { decideListingReviewAction } from "@/app/actions/listings";
import { FormMessage } from "@/components/form";

const initial: FormState = { status: "idle" };

export function DecisionForm({ kind, id }: { kind: "listing" | "identity"; id: string }) {
  const [state, action, pending] = useActionState(
    kind === "listing" ? decideListingReviewAction : reviewIdentityAction,
    initial,
  );
  if (state.status === "success") return <FormMessage state={state} />;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name={kind === "listing" ? "reviewId" : "verificationId"} value={id} />
      <textarea
        name="notes"
        rows={2}
        placeholder={kind === "listing" ? "Notes (required to reject; shown to the seller)" : "Notes (required)"}
        className="block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="APPROVE"
          disabled={pending}
          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="REJECT"
          disabled={pending}
          className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-60"
        >
          Reject
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
