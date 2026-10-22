import { Suspense } from "react";
import Link from "next/link";
import { inputClass } from "@/components/action-form";
import { searchAuditEvents, verifyAuditChain, type AuditQuery } from "@/domains/audit/audit";
import { requireOwner } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Audit log</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <AuditLog searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").trim();
const FILTERS = ["action", "subjectType", "subjectId", "actorUserId"] as const;

async function AuditLog({ searchParams }: { searchParams: PageProps<"/admin/audit">["searchParams"] }) {
  await requireOwner();
  const params = await searchParams;
  const filters = Object.fromEntries(FILTERS.map((k) => [k, one(params[k])])) as Record<(typeof FILTERS)[number], string>;
  const before = one(params.before);
  const query: AuditQuery = {
    action: filters.action || undefined,
    subjectType: filters.subjectType || undefined,
    subjectId: filters.subjectId || undefined,
    actorUserId: filters.actorUserId || undefined,
    beforeSeq: /^\d+$/.test(before) ? BigInt(before) : undefined,
    limit: 50,
  };
  const [{ events, nextBeforeSeq }, chain] = await Promise.all([searchAuditEvents(db, query), verifyAuditChain(db)]);
  const nextHref = (seq: bigint) => {
    const sp = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    sp.set("before", seq.toString());
    return `/admin/audit?${sp}`;
  };

  return (
    <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <p className={`text-sm font-medium ${chain.ok ? "text-emerald-700" : "text-red-700"}`}>
        {chain.ok
          ? `Hash chain intact: all ${chain.checked} events verified. The log is append-only at the database level.`
          : `Hash chain BROKEN at event #${chain.firstBrokenSeq}. Someone altered the database directly.`}
      </p>
      <form className="grid gap-3 sm:grid-cols-5">
        <input name="action" defaultValue={filters.action} placeholder="Action prefix (e.g. enforcement.)" className={inputClass} />
        <input name="subjectType" defaultValue={filters.subjectType} placeholder="Subject type (e.g. Order)" className={inputClass} />
        <input name="subjectId" defaultValue={filters.subjectId} placeholder="Subject ID" className={inputClass} />
        <input name="actorUserId" defaultValue={filters.actorUserId} placeholder="Actor user ID" className={inputClass} />
        <button type="submit" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
          Filter
        </button>
      </form>
      <ul className="divide-y divide-stone-100 text-sm">
        {events.map((e) => (
          <li key={e.id} className="py-2">
            <details>
              <summary className="flex cursor-pointer flex-wrap gap-x-4 font-mono text-xs">
                <span className="text-stone-400">#{e.seq.toString()}</span>
                <span className="text-stone-500">{e.at.toISOString().replace("T", " ").slice(0, 19)}</span>
                <span className="font-semibold">{e.action}</span>
                <span className="text-stone-500">
                  {e.actor ? e.actor.displayName : e.actorType.toLowerCase()} → {e.subjectType}
                  {e.subjectId ? `:${e.subjectId.slice(0, 10)}` : ""}
                </span>
              </summary>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Before</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(e.before, null, 2) ?? "null"}</pre>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">After</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(e.after, null, 2) ?? "null"}</pre>
                </div>
              </div>
              <p className="mt-2 font-mono text-[11px] text-stone-400">
                {e.actorType.toLowerCase()}
                {e.actor && ` (${e.actor.email})`} · subject {e.subjectType}
                {e.subjectId && ` ${e.subjectId}`}
                {e.ipHash && ` · ip ${e.ipHash.slice(0, 10)}`} · hash {e.hash.slice(0, 16)}
              </p>
            </details>
          </li>
        ))}
      </ul>
      {events.length === 0 && <p className="py-6 text-center text-sm text-stone-500">No events match.</p>}
      <div className="flex justify-between text-sm">
        {query.beforeSeq !== undefined ? (
          <Link href={`/admin/audit?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v))}`} className="underline">
            ← Newest
          </Link>
        ) : (
          <span />
        )}
        {nextBeforeSeq !== null && (
          <Link href={nextHref(nextBeforeSeq)} className="underline">
            Older →
          </Link>
        )}
      </div>
    </section>
  );
}
