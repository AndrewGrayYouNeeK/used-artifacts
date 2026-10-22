"use client";

import { useActionState } from "react";
import { ownerSendPasswordResetAction, type FormState } from "@/app/actions/auth";

const initial: FormState = { status: "idle" };

export function SendResetButton({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState(ownerSendPasswordResetAction, initial);

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      {state.status !== "idle" && (
        <span className={`text-xs ${state.status === "success" ? "text-emerald-700" : "text-red-700"}`}>
          {state.status === "success" ? "Sent" : state.message}
        </span>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-50 disabled:opacity-60"
      >
        Send reset email
      </button>
    </form>
  );
}
