import type { AiAnalysis } from "@/generated/prisma/client";
import { RED_FLAG_LABELS, isNormalizedAnalysis } from "@/domains/ai/output";
import { formatUsd } from "@/domains/pricing/pricing";
import { UncertaintyBadge } from "./uncertainty-badge";

interface SellerDecisions {
  previewed?: boolean;
  accepted?: string[];
  rejected?: string[];
}

/** Staff view of a stored photo analysis (compliance queue, GM dashboard). */
export function AiAnalysisSummary({ analysis }: { analysis: AiAnalysis }) {
  const n = isNormalizedAnalysis(analysis.normalizedOutput) ? analysis.normalizedOutput : null;
  const decisions = (analysis.sellerDecisions ?? {}) as SellerDecisions;
  return (
    <div
      className={`space-y-2 rounded-lg p-3 text-xs ${analysis.blocksPublishing ? "border border-red-300 bg-red-50 text-red-950" : "bg-sky-50 text-stone-800"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">AI photo analysis</span>
        <UncertaintyBadge uncertainty={analysis.uncertainty} />
        {analysis.blocksPublishing && (
          <span className="rounded-full bg-red-700 px-2 py-0.5 font-medium text-white">Red flag: approval needs written notes</span>
        )}
        <span className="text-stone-500">
          {analysis.provider}/{analysis.model} · {analysis.promptVersion}
        </span>
      </div>
      {analysis.error && <p className="text-red-800">Analyzer problem: {analysis.error}</p>}
      {n?.identification && (
        <p>
          Possibly {n.identification.label} ({Math.round(n.identification.confidence * 100)}%)
          {n.valueLowCents !== null && n.valueHighCents !== null && ` · range ${formatUsd(n.valueLowCents)}–${formatUsd(n.valueHighCents)}`}
        </p>
      )}
      {n && n.redFlags.length > 0 && (
        <ul className="list-disc pl-5">
          {n.redFlags.map((r) => (
            <li key={r.flag}>
              <strong>{RED_FLAG_LABELS[r.flag]}</strong>
              {r.evidence && `: ${r.evidence}`}
            </li>
          ))}
        </ul>
      )}
      {n && n.screeningMatches.length > 0 && (
        <p>
          Screening terms in the model&apos;s description:{" "}
          {n.screeningMatches.map((m) => `“${m.matchedText}” (${m.reason}${m.blocking ? ", block-level" : ""})`).join("; ")}
        </p>
      )}
      {n && n.observations.length > 0 && <p className="text-stone-600">{n.observations.join(" · ")}</p>}
      {analysis.flags.length > 0 && <p>Flags: {analysis.flags.join(", ")}</p>}
      {analysis.guardrailActions.length > 0 && <p>Guardrails applied: {analysis.guardrailActions.join(", ")}</p>}
      {analysis.listingId && (
        <p className="text-stone-600">
          {decisions.previewed
            ? `Seller saw suggestions. Accepted: ${decisions.accepted?.join(", ") || "none"}. Rejected: ${decisions.rejected?.join(", ") || "none"}.`
            : "Seller didn't preview suggestions; analysis ran at submission."}
        </p>
      )}
    </div>
  );
}
