import { z } from "zod";
import type { AiUncertainty } from "@/generated/prisma/enums";

export const RED_FLAGS = [
  "POSSIBLE_HUMAN_REMAINS",
  "FUNERARY_INDICATORS",
  "SACRED_OR_CEREMONIAL",
  "CULTURAL_PATRIMONY",
  "PROTECTED_WILDLIFE_PARTS",
  "POSSIBLE_REPRODUCTION",
] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

/** Red flags that hold the listing for compliance; a reviewer must justify approving it in writing. */
export const BLOCKING_RED_FLAGS: ReadonlySet<RedFlag> = new Set([
  "POSSIBLE_HUMAN_REMAINS",
  "FUNERARY_INDICATORS",
  "SACRED_OR_CEREMONIAL",
  "CULTURAL_PATRIMONY",
  "PROTECTED_WILDLIFE_PARTS",
]);

export const RED_FLAG_LABELS: Record<RedFlag, string> = {
  POSSIBLE_HUMAN_REMAINS: "Possible human remains",
  FUNERARY_INDICATORS: "Possible funerary object or grave good",
  SACRED_OR_CEREMONIAL: "Possible sacred or ceremonial object",
  CULTURAL_PATRIMONY: "Possible cultural patrimony",
  PROTECTED_WILDLIFE_PARTS: "Possible protected wildlife parts (e.g. eagle feathers)",
  POSSIBLE_REPRODUCTION: "Possible reproduction or modern copy",
};

const text = (max: number) => z.string().trim().max(max);

/**
 * What the model must return (the tool schema in prompt.ts mirrors it).
 * Validation is strict on types; unknown red flags are kept as text evidence
 * but never trusted as a known flag.
 */
export const RawAnalysisSchema = z.object({
  suggestedCategorySlug: text(80).nullish(),
  identification: z.object({ label: text(200), confidence: z.number().min(0).max(1) }).nullish(),
  suggestedTitle: text(120).nullish(),
  materials: text(200).nullish(),
  estimatedAge: text(200).nullish(),
  regionOfOrigin: text(200).nullish(),
  valueRangeUsd: z.object({ low: z.number().nonnegative().max(10_000_000), high: z.number().nonnegative().max(10_000_000) }).nullish(),
  observations: z.array(text(400)).max(12).default([]),
  redFlags: z.array(z.object({ flag: text(60), evidence: text(400) })).max(12).default([]),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
export type RawAnalysis = z.infer<typeof RawAnalysisSchema>;

/** Fields the seller can accept into the listing form. */
export const SUGGESTION_FIELDS = ["categoryId", "title", "materials", "estimatedAge", "regionOfOrigin"] as const;
export type SuggestionField = (typeof SUGGESTION_FIELDS)[number];

/** Stored as AiAnalysis.normalizedOutput and shown to the seller and reviewer. */
export interface NormalizedAnalysis {
  suggestions: Partial<Record<SuggestionField, string>>;
  suggestedCategoryName: string | null;
  identification: { label: string; confidence: number } | null;
  /** Always a range, never a point estimate. */
  valueLowCents: number | null;
  valueHighCents: number | null;
  observations: string[];
  redFlags: { flag: RedFlag; evidence: string }[];
  /** Text the guardrails flagged in the model's own wording (compliance screening terms). */
  screeningMatches: { matchedText: string; reason: string; blocking: boolean }[];
  /** Attach the Indian Arts and Crafts Act disclosure wherever this analysis is shown. */
  iacaDisclosure: boolean;
}

export interface GuardedAnalysis {
  normalized: NormalizedAnalysis;
  uncertainty: AiUncertainty;
  flags: string[];
  guardrailActions: string[];
  blocksPublishing: boolean;
}

export const EMPTY_ANALYSIS: NormalizedAnalysis = {
  suggestions: {},
  suggestedCategoryName: null,
  identification: null,
  valueLowCents: null,
  valueHighCents: null,
  observations: [],
  redFlags: [],
  screeningMatches: [],
  iacaDisclosure: false,
};

export function isNormalizedAnalysis(value: unknown): value is NormalizedAnalysis {
  return typeof value === "object" && value !== null && "suggestions" in value && "redFlags" in value;
}

export const AI_NOTICE =
  "AI suggestions are a starting point, not authentication, grading, or an appraisal. Your listing text is your sworn statement, so check every detail yourself.";
