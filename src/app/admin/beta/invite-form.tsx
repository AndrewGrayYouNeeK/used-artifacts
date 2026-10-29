"use client";

import { useActionState } from "react";
import { createInviteAction, type InviteFormState } from "@/app/actions/beta";
import { inputClass } from "@/components/action-form";
import { FormMessage } from "@/components/form";

const initial: InviteFormState = { status: "idle" };

export function CreateInviteForm() {
  const [state, action, pending] = useActionState(createInviteAction, initial);
  return (
    <div className="space-y-4">
      {state.status === "created" && (
        <div role="status" className="space-y-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p>
            Invite created{state.emailed ? " and emailed" : ""}. This code is shown only once:
          </p>
          <p className="font-mono text-lg tracking-wider">{state.code}</p>
          <p className="break-all text-xs">
            Signup link: <span className="font-mono">{state.link}</span>
          </p>
        </div>
      )}
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 sm:col-span-2">
          <span className="text-sm font-medium">Who it&apos;s for (internal note)</span>
          <input name="note" required minLength={2} maxLength={200} placeholder="e.g. Jim from the Louisville show" className={inputClass} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Lock to email (optional)</span>
          <input name="email" type="email" placeholder="name@example.com" className={inputClass} />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input name="sendEmail" type="checkbox" className="h-4 w-4" />
          Email the invite to that address
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Uses</span>
          <input name="maxUses" type="number" min={1} max={1000} defaultValue={1} className={inputClass} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Expires after (days, blank = never)</span>
          <input name="expiresInDays" type="number" min={1} max={365} defaultValue={30} className={inputClass} />
        </label>
        <div className="sm:col-span-2">
          {state.status !== "created" && <FormMessage state={state} />}
          <button
            type="submit"
            disabled={pending}
            className="mt-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create invite"}
          </button>
        </div>
      </form>
    </div>
  );
}
