import type { FormState } from "@/app/actions/auth";

export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  errors,
  hint,
  defaultValue,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  errors?: string[];
  hint?: string;
  defaultValue?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-stone-800">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        inputMode={inputMode}
        required
        className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200"
      />
      {hint && !errors?.length && <span className="block text-xs text-stone-500">{hint}</span>}
      {errors?.map((e) => (
        <span key={e} className="block text-xs text-red-700">
          {e}
        </span>
      ))}
    </label>
  );
}

export function FormMessage({ state }: { state: FormState }) {
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
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown form state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
      <h1 className="mb-6 font-serif text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}
