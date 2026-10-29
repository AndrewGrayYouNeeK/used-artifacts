"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  confirmTwoFactorAction,
  disableTwoFactorAction,
  regenerateRecoveryCodesAction,
  type SecurityFormState,
} from "@/app/actions/security";

const initial: SecurityFormState = { status: "idle" };
const input =
  "block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";
const button = "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60";

function Message({ state }: { state: SecurityFormState }) {
  switch (state.status) {
    case "idle":
      return null;
    case "error":
      return (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.message}
        </p>
      );
    case "success":
      return (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.message}
        </p>
      );
    case "codes":
      return (
        <div role="status" className="space-y-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p>{state.message}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {state.recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="text-xs">These are shown only once.</p>
        </div>
      );
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown form state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function CodeInput({ label = "Authenticator code" }: { label?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-stone-800">{label}</span>
      <input name="code" required autoComplete="one-time-code" inputMode="numeric" className={input} />
    </label>
  );
}

export function ConfirmEnrollmentForm() {
  const [state, action, pending] = useActionState(confirmTwoFactorAction, initial);
  if (state.status === "codes") {
    return (
      <div className="space-y-4">
        <Message state={state} />
        <Link href="/account" className={`inline-block ${button}`}>
          I saved my codes
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <CodeInput label="6-digit code from the app" />
      <Message state={state} />
      <button type="submit" disabled={pending} className={button}>
        {pending ? "Checking…" : "Turn on two-factor sign-in"}
      </button>
    </form>
  );
}

export function RegenerateCodesForm() {
  const [state, action, pending] = useActionState(regenerateRecoveryCodesAction, initial);
  return (
    <form action={action} className="space-y-3 border-t border-stone-100 pt-4">
      <h3 className="font-medium">New recovery codes</h3>
      <p className="text-stone-500">Replaces all your recovery codes.</p>
      <CodeInput />
      <Message state={state} />
      <button type="submit" disabled={pending} className={button}>
        {pending ? "Working…" : "Generate new codes"}
      </button>
    </form>
  );
}

export function DisableTwoFactorForm() {
  const [state, action, pending] = useActionState(disableTwoFactorAction, initial);
  return (
    <form action={action} className="space-y-3 border-t border-stone-100 pt-4">
      <h3 className="font-medium">Turn off two-factor sign-in</h3>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-stone-800">Password</span>
        <input name="password" type="password" required autoComplete="current-password" className={input} />
      </label>
      <CodeInput label="Authenticator or recovery code" />
      <Message state={state} />
      <button type="submit" disabled={pending} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60">
        {pending ? "Working…" : "Turn off"}
      </button>
    </form>
  );
}
