import type { ProhibitedTermSeverity } from "@/generated/prisma/enums";
import { BASELINE_PROHIBITED_TERMS } from "./prohibited-terms";

export interface ScreeningTerm {
  pattern: string;
  isRegex: boolean;
  severity: ProhibitedTermSeverity;
  reason: string;
}

export interface ScreeningMatch {
  field: string;
  pattern: string;
  matchedText: string;
  severity: ProhibitedTermSeverity;
  reason: string;
}

export interface ScreeningResult {
  blocked: ScreeningMatch[];
  review: ScreeningMatch[];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizeForScreening(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function compile(term: ScreeningTerm): RegExp | null {
  const source = term.isRegex ? term.pattern : escapeRegex(term.pattern.toLowerCase());
  try {
    return new RegExp(`(?<![a-z0-9])(?:${source})(?![a-z0-9])`, "i");
  } catch {
    return null;
  }
}

/** Baseline terms are always included; `extra` comes from the ProhibitedTerm table. */
export function screeningTerms(extra: ScreeningTerm[] = []): ScreeningTerm[] {
  const byPattern = new Map<string, ScreeningTerm>();
  for (const t of BASELINE_PROHIBITED_TERMS) {
    byPattern.set(t.pattern, { pattern: t.pattern, isRegex: t.isRegex ?? false, severity: t.severity, reason: t.reason });
  }
  for (const t of extra) {
    const existing = byPattern.get(t.pattern);
    // Staff can tighten a baseline term to BLOCK, never loosen it to REVIEW.
    if (existing?.severity === "BLOCK" && t.severity !== "BLOCK") continue;
    byPattern.set(t.pattern, t);
  }
  return [...byPattern.values()];
}

export function screenFields(
  fields: Record<string, string | null | undefined>,
  terms: ScreeningTerm[] = screeningTerms(),
): ScreeningResult {
  const result: ScreeningResult = { blocked: [], review: [] };
  const compiled = terms.flatMap((t) => {
    const re = compile(t);
    return re ? [{ term: t, re }] : [];
  });
  for (const [field, raw] of Object.entries(fields)) {
    if (!raw) continue;
    const text = normalizeForScreening(raw);
    for (const { term, re } of compiled) {
      const m = re.exec(text);
      if (!m) continue;
      const match: ScreeningMatch = {
        field,
        pattern: term.pattern,
        matchedText: m[0],
        severity: term.severity,
        reason: term.reason,
      };
      switch (term.severity) {
        case "BLOCK":
          result.blocked.push(match);
          break;
        case "REVIEW":
          result.review.push(match);
          break;
        default: {
          const exhaustive: never = term.severity;
          throw new Error(`Unknown severity: ${String(exhaustive)}`);
        }
      }
    }
  }
  return result;
}
