import type { AiUncertainty } from "@/generated/prisma/enums";
import { normalizeForScreening, screenFields, type ScreeningTerm } from "@/domains/compliance/screening";
import {
  BLOCKING_RED_FLAGS,
  EMPTY_ANALYSIS,
  RED_FLAGS,
  RawAnalysisSchema,
  type GuardedAnalysis,
  type NormalizedAnalysis,
  type RedFlag,
  type SuggestionField,
} from "./output";

export interface GuardrailCategory {
  id: string;
  slug: string;
  name: string;
  isNativeAmerican: boolean;
}

export interface GuardrailContext {
  /** Leaf categories the seller may list in (enabled verticals only). */
  categories: GuardrailCategory[];
  /** The category the seller selected, if any. */
  selectedCategoryId?: string | null;
  screeningTerms: ScreeningTerm[];
}

const TRIBES = [
  "cherokee", "navajo", "diné", "dine", "hopi", "zuni", "zuñi", "apache", "lakota", "sioux", "dakota", "nakota",
  "ojibwe", "ojibwa", "chippewa", "anishinaabe", "iroquois", "haudenosaunee", "seneca", "mohawk", "oneida", "onondaga",
  "cayuga", "tuscarora", "choctaw", "chickasaw", "creek", "muscogee", "seminole", "shawnee", "miami", "pueblo", "acoma",
  "tlingit", "haida", "tsimshian", "kwakwaka'wakw", "cheyenne", "arapaho", "comanche", "kiowa", "osage", "pawnee",
  "crow", "blackfeet", "blackfoot", "nez perce", "ute", "shoshone", "paiute", "yakama", "lenape", "delaware",
  "potawatomi", "menominee", "ho-chunk", "winnebago", "mandan", "hidatsa", "arikara", "caddo", "wichita", "quapaw",
  "pima", "tohono o'odham", "yaqui", "inuit", "yupik", "aleut", "salish", "chumash", "pomo", "mohegan", "pequot",
  "wampanoag", "narragansett", "abenaki", "passamaquoddy", "penobscot", "mi'kmaq", "catawba", "powhatan", "natchez",
];
/** Archaeological cultures: an attribution, not a maker claim, but still unverified. */
const CULTURES = [
  "adena", "hopewell", "mississippian", "fort ancient", "clovis", "folsom", "dalton", "anasazi", "ancestral puebloan",
  "mimbres", "hohokam", "mogollon", "woodland", "archaic", "paleo-indian", "paleoindian", "poverty point",
];

const alt = (words: string[]) => words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[- ]")).join("|");
const PEOPLES = `native americans?|american indians?|indians?|indigenous|first nations?|${alt(TRIBES)}|${alt(CULTURES)}`;

/** "Indian-made", "Navajo-made", "made by the Cherokee", "authentic Native American made" … */
const MAKER_CLAIMS = [
  new RegExp(`(?<![a-z])(?:authentic |genuine |real )?(?:${PEOPLES})[- ](?:made|crafted|produced|carved|knapped|created)(?![a-z])`, "gi"),
  new RegExp(
    `(?<![a-z])(?:made|crafted|produced|carved|knapped|created|manufactured) by (?:an? |the )?(?:${PEOPLES})(?: (?:people|tribe|nation|artisans?|craftsm[ae]n|makers?|artists?))?(?![a-z])`,
    "gi",
  ),
  new RegExp(`(?<![a-z])(?:authentic|genuine) (?:${PEOPLES})(?= (?:art|artifacts?|crafts?|items?|pieces?|work|pottery|jewelry|baskets?|textiles?|points?|blades?)(?![a-z]))`, "gi"),
];
const ATTRIBUTION = new RegExp(`(?<![a-z])(?:${PEOPLES}|tribe|tribal)(?![a-z])`, "i");

/** The analyzer can never authenticate, certify, or grade. */
const AUTHENTICATION_CLAIMS =
  /\b(?:authenticated|certified(?: authentic| genuine)?|certificate of authenticity|guaranteed (?:authentic|genuine|original)|museum[- ]grade|museum[- ]quality|(?:is|are) (?:authentic|genuine))\b/gi;
const GRADING_KEYS = /authent|certif|grade|grading|tier/i;

const UNVERIFIED = "style/attribution unverified";
const UNCERTAINTY_ORDER: AiUncertainty[] = ["LOW", "MEDIUM", "HIGH"];
const atLeast = (a: AiUncertainty, b: AiUncertainty): AiUncertainty =>
  UNCERTAINTY_ORDER[Math.max(UNCERTAINTY_ORDER.indexOf(a), UNCERTAINTY_ORDER.indexOf(b))];

/** Minimum high/low ratio of the value range for each uncertainty level. */
const MIN_RANGE_RATIO: Record<AiUncertainty, number> = { LOW: 1.25, MEDIUM: 1.5, HIGH: 2 };

/**
 * Deterministic post-processing of the model's output. The prompt asks for
 * the same behavior, but only this code is trusted: it strips maker and
 * authentication claims, forces HIGH uncertainty on any Native American
 * attribution, turns point estimates into ranges, and decides whether the
 * listing must be held for compliance.
 */
export function applyGuardrails(raw: unknown, ctx: GuardrailContext): GuardedAnalysis {
  const actions = new Set<string>();
  const flags = new Set<string>();

  if (raw && typeof raw === "object" && Object.keys(raw).some((k) => GRADING_KEYS.test(k))) {
    actions.add("DROPPED_AUTHENTICATION_FIELDS");
  }
  const parsed = RawAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      normalized: { ...EMPTY_ANALYSIS, iacaDisclosure: selectedIsNativeAmerican(ctx) },
      uncertainty: "HIGH",
      flags: ["INVALID_OUTPUT"],
      guardrailActions: [...actions, "REJECTED_INVALID_OUTPUT"],
      blocksPublishing: false,
    };
  }
  const out = parsed.data;

  const clean = (value: string | null | undefined): string | null => {
    if (!value) return null;
    let result = value;
    for (const pattern of MAKER_CLAIMS) {
      const next = result.replace(pattern, UNVERIFIED);
      if (next !== result) actions.add("STRIPPED_MAKER_CLAIM");
      result = next;
    }
    const next = result.replace(AUTHENTICATION_CLAIMS, "unverified");
    if (next !== result) actions.add("STRIPPED_AUTHENTICATION_CLAIM");
    return next.trim() || null;
  };

  const suggestions: Partial<Record<SuggestionField, string>> = {};
  let suggestedCategory: GuardrailCategory | undefined;
  if (out.suggestedCategorySlug) {
    suggestedCategory = ctx.categories.find((c) => c.slug === out.suggestedCategorySlug);
    if (suggestedCategory) suggestions.categoryId = suggestedCategory.id;
    else actions.add("DROPPED_UNKNOWN_CATEGORY");
  }
  for (const [field, value] of [
    ["title", out.suggestedTitle],
    ["materials", out.materials],
    ["estimatedAge", out.estimatedAge],
    ["regionOfOrigin", out.regionOfOrigin],
  ] as const) {
    const cleaned = clean(value);
    if (cleaned) suggestions[field] = cleaned;
  }
  const identificationLabel = clean(out.identification?.label);
  const identification =
    out.identification && identificationLabel ? { label: identificationLabel, confidence: out.identification.confidence } : null;
  const observations = out.observations.map(clean).filter((o): o is string => o !== null);

  const redFlags: NormalizedAnalysis["redFlags"] = [];
  for (const r of out.redFlags) {
    const known = (RED_FLAGS as readonly string[]).includes(r.flag) ? (r.flag as RedFlag) : null;
    if (!known) {
      actions.add("IGNORED_UNKNOWN_RED_FLAG");
      observations.push(`Model note: ${clean(r.evidence) ?? r.flag}`);
      continue;
    }
    redFlags.push({ flag: known, evidence: clean(r.evidence) ?? "" });
    flags.add(known);
  }

  const rawText = [
    out.suggestedTitle,
    out.materials,
    out.estimatedAge,
    out.regionOfOrigin,
    out.identification?.label,
    ...out.observations,
    ...out.redFlags.map((r) => r.evidence),
  ].filter((t): t is string => Boolean(t));
  // Screen what survives cleaning: a maker claim the guardrails already stripped is the model's
  // wording, not the seller's, and must not hold the listing on its own.
  const cleanedText = [...Object.values(suggestions), identification?.label, ...observations, ...redFlags.map((r) => r.evidence)].filter(
    (t): t is string => Boolean(t),
  );
  const screening = screenFields(Object.fromEntries(cleanedText.map((t, i) => [`ai${i}`, t])), ctx.screeningTerms);
  const screeningMatches = [
    ...screening.blocked.map((m) => ({ matchedText: m.matchedText, reason: m.reason, blocking: true })),
    ...screening.review.map((m) => ({ matchedText: m.matchedText, reason: m.reason, blocking: false })),
  ];
  if (screeningMatches.length > 0) flags.add("SCREENING_TERMS_IN_ANALYSIS");

  let uncertainty: AiUncertainty = out.uncertainty;
  if (identification && identification.confidence < 0.5 && uncertainty === "LOW") {
    uncertainty = "MEDIUM";
    actions.add("RAISED_UNCERTAINTY_LOW_CONFIDENCE");
  }
  const attributed =
    selectedIsNativeAmerican(ctx) ||
    Boolean(suggestedCategory?.isNativeAmerican) ||
    rawText.some((t) => ATTRIBUTION.test(normalizeForScreening(t)));
  if (attributed) {
    flags.add("NATIVE_AMERICAN_ATTRIBUTION");
    actions.add("IACA_DISCLOSURE_ATTACHED");
    if (uncertainty !== "HIGH") actions.add("FORCED_HIGH_UNCERTAINTY");
    uncertainty = "HIGH";
  }
  if (redFlags.length > 0) uncertainty = atLeast(uncertainty, "MEDIUM");

  let valueLowCents: number | null = null;
  let valueHighCents: number | null = null;
  if (out.valueRangeUsd && out.valueRangeUsd.high > 0) {
    let low = Math.round(Math.min(out.valueRangeUsd.low, out.valueRangeUsd.high) * 100);
    let high = Math.round(Math.max(out.valueRangeUsd.low, out.valueRangeUsd.high) * 100);
    const ratio = MIN_RANGE_RATIO[uncertainty];
    if (low === 0 || high / low < ratio) {
      const mid = low === 0 ? high / Math.sqrt(ratio) : Math.sqrt(low * high);
      low = Math.max(100, Math.floor(mid / Math.sqrt(ratio)));
      high = Math.max(low + 100, Math.ceil(mid * Math.sqrt(ratio)));
      actions.add(out.valueRangeUsd.low === out.valueRangeUsd.high ? "WIDENED_POINT_ESTIMATE" : "WIDENED_VALUE_RANGE");
    }
    valueLowCents = low;
    valueHighCents = high;
  }
  if (identification && identification.confidence < 0.5) flags.add("LOW_CONFIDENCE");

  const blocksPublishing = redFlags.some((r) => BLOCKING_RED_FLAGS.has(r.flag)) || screening.blocked.length > 0;
  return {
    normalized: {
      suggestions,
      suggestedCategoryName: suggestedCategory?.name ?? null,
      identification,
      valueLowCents,
      valueHighCents,
      observations,
      redFlags,
      screeningMatches,
      iacaDisclosure: attributed,
    },
    uncertainty,
    flags: [...flags],
    guardrailActions: [...actions],
    blocksPublishing,
  };
}

function selectedIsNativeAmerican(ctx: GuardrailContext): boolean {
  return Boolean(ctx.selectedCategoryId && ctx.categories.find((c) => c.id === ctx.selectedCategoryId)?.isNativeAmerican);
}

/** Recorded when the provider fails: the listing still goes to staff review, just without AI help. */
export function unavailableAnalysis(ctx: GuardrailContext): GuardedAnalysis {
  return {
    normalized: { ...EMPTY_ANALYSIS, iacaDisclosure: selectedIsNativeAmerican(ctx) },
    uncertainty: "HIGH",
    flags: ["ANALYZER_UNAVAILABLE"],
    guardrailActions: [],
    blocksPublishing: false,
  };
}
