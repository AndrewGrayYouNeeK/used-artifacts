import type { Db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { isVerticalEnabled, platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { screeningTerms } from "@/domains/compliance/screening";
import { applyGuardrails, unavailableAnalysis, type GuardrailCategory, type GuardrailContext } from "./guardrails";
import { SUGGESTION_FIELDS, type GuardedAnalysis, type SuggestionField } from "./output";
import { PROMPT_VERSION, buildVisionRequest, type VisionImage, type VisionProvider } from "./vision";

export interface AnalyzerDeps {
  db: Db;
  vision: VisionProvider;
  now?: () => Date;
  platform?: PlatformConfig;
  /** Suggestion runs per seller per 24 hours (each one costs a model call). */
  dailyLimit?: number;
  timeoutMs?: number;
}

export const DAILY_SUGGESTION_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 45_000;
/** A suggestion run can be reused at submission for this long. */
const SUGGESTION_REUSE_MS = 24 * 60 * 60 * 1000;

export interface AnalysisPhoto {
  bytes: Uint8Array;
  pHash: string;
}

export interface RecordedAnalysis extends GuardedAnalysis {
  id: string;
  error: string | null;
}

export async function analyzerCategories(db: Db, config: PlatformConfig = platform): Promise<GuardrailCategory[]> {
  const rows = await db.category.findMany({
    where: { parentId: { not: null } },
    select: { id: true, slug: true, name: true, isNativeAmerican: true, vertical: true },
    orderBy: { name: "asc" },
  });
  return rows
    .filter((c) => isVerticalEnabled(c.vertical, config))
    .map(({ id, slug, name, isNativeAmerican }) => ({ id, slug, name, isNativeAmerican }));
}

async function guardrailContext(deps: AnalyzerDeps, categoryId: string | null | undefined): Promise<GuardrailContext> {
  const terms = await deps.db.prohibitedTerm.findMany({ select: { pattern: true, isRegex: true, severity: true, reason: true } });
  return {
    categories: await analyzerCategories(deps.db, deps.platform),
    selectedCategoryId: categoryId ?? null,
    screeningTerms: screeningTerms(terms),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Vision analysis timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runAndRecord(
  deps: AnalyzerDeps,
  input: { userId: string; photos: AnalysisPhoto[]; categoryId?: string | null },
  ctx: RequestContext,
): Promise<RecordedAnalysis> {
  const gctx = await guardrailContext(deps, input.categoryId);
  const selected = gctx.categories.find((c) => c.id === input.categoryId) ?? null;
  const images: VisionImage[] = input.photos.map((p) => ({ bytes: p.bytes, mediaType: "image/webp" }));
  let raw: unknown = null;
  let guarded: GuardedAnalysis;
  let error: string | null = null;
  try {
    raw = await withTimeout(deps.vision.analyze(buildVisionRequest(images, gctx.categories, selected)), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    guarded = applyGuardrails(raw, gctx);
    if (guarded.flags.includes("INVALID_OUTPUT")) error = "The model returned output that failed validation.";
  } catch (err) {
    guarded = unavailableAnalysis(gctx);
    error = String(err instanceof Error ? err.message : err).slice(0, 500);
  }
  return record(
    deps,
    {
      userId: input.userId,
      categoryId: selected?.id ?? null,
      photoHashes: input.photos.map((p) => p.pHash),
      provider: deps.vision.name,
      model: deps.vision.model,
      raw,
      guarded,
      error,
    },
    ctx,
  );
}

async function record(
  deps: AnalyzerDeps,
  input: {
    userId: string;
    categoryId: string | null;
    photoHashes: string[];
    provider: string;
    model: string;
    raw: unknown;
    guarded: GuardedAnalysis;
    error: string | null;
  },
  ctx: RequestContext,
): Promise<RecordedAnalysis> {
  const { guarded, error } = input;
  const row = await deps.db.$transaction(async (tx) => {
    const created = await tx.aiAnalysis.create({
      data: {
        requestedByUserId: input.userId,
        categoryId: input.categoryId,
        photoHashes: input.photoHashes,
        provider: input.provider,
        model: input.model,
        promptVersion: PROMPT_VERSION,
        rawOutput: (input.raw ?? {}) as Prisma.InputJsonValue,
        normalizedOutput: guarded.normalized as unknown as Prisma.InputJsonValue,
        uncertainty: guarded.uncertainty,
        flags: guarded.flags,
        guardrailActions: guarded.guardrailActions,
        blocksPublishing: guarded.blocksPublishing,
        error,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "ai.analysis_recorded",
      subjectType: "AiAnalysis",
      subjectId: created.id,
      after: {
        provider: created.provider,
        model: created.model,
        promptVersion: created.promptVersion,
        uncertainty: created.uncertainty,
        flags: created.flags,
        guardrailActions: created.guardrailActions,
        blocksPublishing: created.blocksPublishing,
        error,
      },
      ipHash: ctx.ipHash,
    });
    return created;
  });
  return { ...guarded, id: row.id, error };
}

export type SuggestResult = { ok: true; analysis: RecordedAnalysis } | { ok: false; reason: "RATE_LIMITED" | "NO_PHOTOS" };

/** A pre-submission run whose suggestions the seller may accept into the form. */
export async function suggestFromPhotos(
  deps: AnalyzerDeps,
  input: { userId: string; photos: AnalysisPhoto[]; categoryId?: string | null },
  ctx: RequestContext = {},
): Promise<SuggestResult> {
  if (input.photos.length === 0) return { ok: false, reason: "NO_PHOTOS" };
  const now = deps.now ? deps.now() : new Date();
  const recent = await deps.db.aiAnalysis.count({
    where: { requestedByUserId: input.userId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  if (recent >= (deps.dailyLimit ?? DAILY_SUGGESTION_LIMIT)) return { ok: false, reason: "RATE_LIMITED" };
  return { ok: true, analysis: await runAndRecord(deps, input, ctx) };
}

const sameHashes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Every submission gets an analysis: the seller's own suggestion run when it
 * covered exactly these photos, otherwise a fresh one. If the seller changed
 * the category since, the guardrails are re-applied to the stored model
 * output for the new category (no new model call). Not rate-limited, so the
 * analyzer can't be skipped by exhausting the quota.
 */
export async function analysisForSubmission(
  deps: AnalyzerDeps,
  input: { userId: string; photos: AnalysisPhoto[]; categoryId: string; suggestionId?: string | null },
  ctx: RequestContext = {},
): Promise<RecordedAnalysis & { reused: boolean }> {
  const now = deps.now ? deps.now() : new Date();
  if (input.suggestionId) {
    const prior = await deps.db.aiAnalysis.findFirst({
      where: {
        id: input.suggestionId,
        requestedByUserId: input.userId,
        listingId: null,
        createdAt: { gte: new Date(now.getTime() - SUGGESTION_REUSE_MS) },
      },
    });
    if (prior && !prior.error && sameHashes(prior.photoHashes, input.photos.map((p) => p.pHash))) {
      if (prior.categoryId !== input.categoryId) {
        const guarded = applyGuardrails(prior.rawOutput, await guardrailContext(deps, input.categoryId));
        const derived = await record(
          deps,
          {
            userId: input.userId,
            categoryId: input.categoryId,
            photoHashes: prior.photoHashes,
            provider: prior.provider,
            model: prior.model,
            raw: prior.rawOutput,
            guarded: { ...guarded, guardrailActions: [...guarded.guardrailActions, "REEVALUATED_FOR_CATEGORY"] },
            error: null,
          },
          ctx,
        );
        return { ...derived, reused: true };
      }
      return {
        id: prior.id,
        error: null,
        reused: true,
        normalized: prior.normalizedOutput as unknown as GuardedAnalysis["normalized"],
        uncertainty: prior.uncertainty,
        flags: prior.flags,
        guardrailActions: prior.guardrailActions,
        blocksPublishing: prior.blocksPublishing,
      };
    }
  }
  return { ...(await runAndRecord(deps, input, ctx)), reused: false };
}

export function parseAcceptedSuggestions(values: string[]): SuggestionField[] {
  return [...new Set(values.filter((v): v is SuggestionField => (SUGGESTION_FIELDS as readonly string[]).includes(v)))];
}

/** Links the analysis to the new listing and records which suggestions the seller took. */
export async function attachAnalysis(
  tx: Tx,
  input: { analysis: RecordedAnalysis & { reused: boolean }; listingId: string; photoIds: string[]; accepted: SuggestionField[] },
) {
  const offered = Object.keys(input.analysis.normalized.suggestions) as SuggestionField[];
  const accepted = input.analysis.reused ? input.accepted.filter((f) => offered.includes(f)) : [];
  await tx.aiAnalysis.update({
    where: { id: input.analysis.id },
    data: {
      listingId: input.listingId,
      photoIds: input.photoIds,
      sellerDecisions: {
        previewed: input.analysis.reused,
        accepted,
        rejected: input.analysis.reused ? offered.filter((f) => !accepted.includes(f)) : [],
      },
    },
  });
}
