import { RED_FLAGS } from "./output";
import type { GuardrailCategory } from "./guardrails";

export const PROMPT_VERSION = "photo-analyzer-v1";

export interface VisionImage {
  bytes: Uint8Array;
  mediaType: "image/webp" | "image/jpeg" | "image/png";
}

export interface VisionRequest {
  images: VisionImage[];
  system: string;
  instructions: string;
  /** JSON schema of the single tool the model must call with its analysis. */
  toolSchema: Record<string, unknown>;
}

export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the model's tool input as untrusted JSON; guardrails validate it. */
  analyze(request: VisionRequest): Promise<unknown>;
}

export class VisionUnavailableError extends Error {}

export const ANALYSIS_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["uncertainty", "observations", "redFlags"],
  properties: {
    suggestedCategorySlug: { type: ["string", "null"], description: "One slug from the category list, or null." },
    identification: {
      type: ["object", "null"],
      required: ["label", "confidence"],
      properties: {
        label: { type: "string", description: "Candidate type, e.g. 'side-notched projectile point'. Never a maker or tribe." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    suggestedTitle: { type: ["string", "null"], maxLength: 120 },
    materials: { type: ["string", "null"] },
    estimatedAge: { type: ["string", "null"], description: "A broad period with 'possibly'/'likely' wording." },
    regionOfOrigin: { type: ["string", "null"] },
    valueRangeUsd: {
      type: ["object", "null"],
      required: ["low", "high"],
      properties: { low: { type: "number" }, high: { type: "number" } },
      description: "A wide resale range in USD. Never a single number.",
    },
    observations: { type: "array", items: { type: "string" }, maxItems: 12, description: "Patina, wear, damage, repairs, signs of modern manufacture." },
    redFlags: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["flag", "evidence"],
        properties: { flag: { type: "string", enum: [...RED_FLAGS] }, evidence: { type: "string" } },
      },
    },
    uncertainty: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  },
};

const SYSTEM = `You help sellers on Used Artifacts, a marketplace for legally owned artifacts, describe their items from photos.
Rules you must follow:
- You never authenticate, certify, appraise, or grade. You suggest; staff and the seller decide.
- Never claim or imply an item was made by Native Americans, American Indians, or any tribe or specific maker. Use "style" wording (e.g. "Adena-style") and say attribution is unverified.
- Give value as a wide resale range, never a single number. Prefer HIGH uncertainty when photos are unclear.
- Report red flags whenever there is any chance of: human remains (bone, teeth, hair), funerary objects or grave goods, sacred or ceremonial objects, cultural patrimony, protected wildlife parts (eagle or migratory bird feathers, ivory), or a modern reproduction.
- Describe only what is visible. Do not invent provenance.`;

export function buildVisionRequest(images: VisionImage[], categories: GuardrailCategory[], selected?: GuardrailCategory | null): VisionRequest {
  const list = categories.map((c) => `- ${c.slug}: ${c.name}`).join("\n");
  return {
    images,
    system: SYSTEM,
    instructions: `Analyze these ${images.length} photo(s) of one item listed for sale.
${selected ? `The seller chose the category "${selected.name}" (${selected.slug}).\n` : ""}Allowed categories:
${list}
Call the record_analysis tool with your analysis.`,
    toolSchema: ANALYSIS_TOOL_SCHEMA,
  };
}
