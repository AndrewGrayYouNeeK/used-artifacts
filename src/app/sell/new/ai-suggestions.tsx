"use client";

import type { SuggestState } from "@/app/actions/listings";
import { AI_NOTICE, RED_FLAG_LABELS, type SuggestionField } from "@/domains/ai/output";
import { formatUsd } from "@/domains/pricing/pricing";
import { UncertaintyBadge } from "@/components/uncertainty-badge";

const FIELD_LABELS: Record<SuggestionField, string> = {
  categoryId: "Category",
  title: "Title",
  materials: "Materials",
  estimatedAge: "Estimated age",
  regionOfOrigin: "Region of origin",
};

export function AiSuggestions({
  state,
  pending,
  canAnalyze,
  stale,
  onAnalyze,
  accepted,
  availableFields,
  onUse,
  iacaDisclosure,
}: {
  state: SuggestState;
  pending: boolean;
  canAnalyze: boolean;
  /** Photos or category changed since the analysis ran. */
  stale: boolean;
  onAnalyze: () => void;
  accepted: ReadonlySet<SuggestionField>;
  /** Fields present in the form right now (Native American fields only show for those categories). */
  availableFields: ReadonlySet<SuggestionField>;
  onUse: (field: SuggestionField, value: string) => void;
  iacaDisclosure: string;
}) {
  const ready = state.status === "ready" && !stale ? state : null;
  const a = ready?.normalized;
  return (
    <div className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-stone-900">AI photo suggestions (optional)</p>
          <p className="text-xs text-stone-600">Every submission is also checked by the analyzer for our compliance team.</p>
        </div>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!canAnalyze || pending}
          className="shrink-0 rounded-lg border border-sky-300 bg-white px-3 py-2 text-sm font-medium text-sky-900 hover:bg-sky-50 disabled:opacity-50"
        >
          {pending ? "Analyzing…" : ready ? "Analyze again" : "Get suggestions"}
        </button>
      </div>
      {state.status === "error" && <p className="text-sm text-red-700">{state.message}</p>}
      {stale && state.status === "ready" && (
        <p className="text-xs text-stone-600">Photos or category changed. Run the analysis again for current suggestions.</p>
      )}
      {ready && a && (
        <div className="space-y-3 text-sm">
          {ready.unavailable ? (
            <p className="text-stone-700">The analyzer is unavailable right now. You can still submit; staff review every listing.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <UncertaintyBadge uncertainty={ready.uncertainty} />
                {a.identification && (
                  <span className="text-stone-800">
                    Possibly: <strong>{a.identification.label}</strong> ({Math.round(a.identification.confidence * 100)}% confidence)
                  </span>
                )}
              </div>
              {a.valueLowCents !== null && a.valueHighCents !== null && (
                <p className="text-stone-700">
                  Rough resale range: {formatUsd(a.valueLowCents)} – {formatUsd(a.valueHighCents)}. Not an appraisal.
                </p>
              )}
              {a.redFlags.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
                  <p className="font-medium">Our compliance team will look closely at this item:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {a.redFlags.map((r) => (
                      <li key={r.flag}>
                        {RED_FLAG_LABELS[r.flag]}
                        {r.evidence && <span className="text-red-800">: {r.evidence}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs">Items that are human remains, funerary, sacred, or cultural patrimony can&apos;t be sold here.</p>
                </div>
              )}
              {Object.keys(a.suggestions).length > 0 && (
                <ul className="divide-y divide-sky-100 rounded-lg bg-white ring-1 ring-sky-100">
                  {(Object.entries(a.suggestions) as [SuggestionField, string][]).map(([field, value]) => (
                    <li key={field} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span>
                        <span className="text-xs text-stone-500">{FIELD_LABELS[field]}</span>
                        <span className="block text-stone-900">{field === "categoryId" ? (a.suggestedCategoryName ?? value) : value}</span>
                      </span>
                      {accepted.has(field) ? (
                        <span className="text-xs font-medium text-emerald-700">Added</span>
                      ) : availableFields.has(field) ? (
                        <button
                          type="button"
                          onClick={() => onUse(field, value)}
                          className="rounded-md border border-stone-300 px-2 py-1 text-xs font-medium hover:bg-stone-50"
                        >
                          Use
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {a.observations.length > 0 && (
                <ul className="list-disc pl-5 text-stone-700">
                  {a.observations.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              )}
              {a.iacaDisclosure && <p className="rounded-lg bg-white p-3 text-xs text-stone-700 ring-1 ring-amber-200">{iacaDisclosure}</p>}
            </>
          )}
          <p className="text-xs text-stone-500">{AI_NOTICE}</p>
        </div>
      )}
    </div>
  );
}
