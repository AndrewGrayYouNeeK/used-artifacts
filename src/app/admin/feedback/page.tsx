import { Suspense } from "react";
import Link from "next/link";
import { handleFeedbackAction } from "@/app/actions/beta";
import { ActionForm, inputClass } from "@/components/action-form";
import { FEEDBACK_CATEGORIES } from "@/domains/admin/feedback-categories";
import { listFeedback } from "@/domains/admin/feedback";
import { FeedbackStatus } from "@/generated/prisma/enums";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminFeedbackPage({ searchParams }: PageProps<"/admin/feedback">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Beta feedback</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <FeedbackQueue searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const FILTERS = ["OPEN", "ACKNOWLEDGED", "CLOSED", "ALL"] as const;
type Filter = (typeof FILTERS)[number];
const categoryLabel = new Map(FEEDBACK_CATEGORIES.map((c) => [c.value, c.label]));
const time = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);

async function FeedbackQueue({ searchParams }: { searchParams: PageProps<"/admin/feedback">["searchParams"] }) {
  await requireStaff();
  const { status } = await searchParams;
  const filter: Filter = FILTERS.find((f) => f === status) ?? "OPEN";
  const items = await listFeedback(db, filter);

  return (
    <>
      <nav className="flex gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/admin/feedback?status=${f}`}
            className={`rounded-full px-3 py-1 ${f === filter ? "bg-stone-900 text-white" : "border border-stone-300 text-stone-700 hover:bg-stone-50"}`}
          >
            {f.toLowerCase()}
          </Link>
        ))}
      </nav>
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={item.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.category === "TRUST_SAFETY" ? "bg-red-50 text-red-700" : "bg-stone-100 text-stone-700"}`}
              >
                {categoryLabel.get(item.category)}
              </span>
              <Link href={`/admin/users/${item.user.id}`} className="font-medium underline">
                {item.user.displayName}
              </Link>
              <span className="text-stone-500">{time(item.createdAt)}</span>
              {item.pagePath && <span className="font-mono text-xs text-stone-500">{item.pagePath}</span>}
              <span className="ml-auto text-xs text-stone-500">{item.status.toLowerCase()}</span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-stone-800">{item.message}</p>
            {item.handledBy && (
              <p className="mt-2 text-xs text-stone-500">
                {item.handledBy.displayName}
                {item.handledAt ? `, ${time(item.handledAt)}` : ""}: {item.staffNotes ?? "no notes"}
              </p>
            )}
            <ActionForm action={handleFeedbackAction} submitLabel="Save" variant="secondary" className="mt-3 flex flex-wrap items-start gap-2">
              <input type="hidden" name="feedbackId" value={item.id} />
              <select name="status" defaultValue={item.status === "OPEN" ? "ACKNOWLEDGED" : item.status} className={`${inputClass} w-40`}>
                {Object.values(FeedbackStatus).map((s) => (
                  <option key={s} value={s}>
                    {s.toLowerCase()}
                  </option>
                ))}
              </select>
              <input name="notes" defaultValue={item.staffNotes ?? ""} placeholder="Notes (internal)" className={`${inputClass} flex-1`} />
            </ActionForm>
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-stone-500">Nothing here.</li>}
      </ul>
    </>
  );
}
