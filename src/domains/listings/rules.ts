import { z } from "zod";
import { AcquisitionSource } from "@/generated/prisma/enums";
import { parseUsdToCents } from "@/domains/pricing/pricing";
import type { Attestation } from "@/domains/compliance/provenance-template";
import { legalNamesMatch } from "@/domains/identity/legal-name";

export const MIN_ASKING_CENTS = 100;
export const MAX_ASKING_CENTS = 100_000_000;
export const MAX_SHIPPING_CENTS = 100_000;

export const AskingPriceSchema = z.string().transform((v, ctx) => {
  const cents = parseUsdToCents(v);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: "Enter a price like 125 or 125.50." });
    return z.NEVER;
  }
  if (cents < MIN_ASKING_CENTS || cents > MAX_ASKING_CENTS) {
    ctx.addIssue({ code: "custom", message: "Asking price must be between $1 and $1,000,000." });
    return z.NEVER;
  }
  return cents;
});

export const ShippingPriceSchema = z.string().transform((v, ctx) => {
  if (v.trim() === "") return 0;
  const cents = parseUsdToCents(v);
  if (cents === null || cents > MAX_SHIPPING_CENTS) {
    ctx.addIssue({ code: "custom", message: "Enter US shipping between $0 and $1,000 (0 for free shipping)." });
    return z.NEVER;
  }
  return cents;
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional();

export const ListingSubmissionSchema = z.object({
  categoryId: z.string().min(1, { error: "Choose a category." }),
  title: z.string().trim().min(5, { error: "Title must be at least 5 characters." }).max(120),
  description: z
    .string()
    .trim()
    .min(20, { error: "Describe the item in at least 20 characters." })
    .max(5000),
  askingPrice: AskingPriceSchema,
  shipping: ShippingPriceSchema.default(0),
  sellerConditionGrade: optionalText(60),
  regionOfOrigin: optionalText(120),
  estimatedAge: optionalText(120),
  materials: optionalText(200),
  acquisitionSource: z.enum(AcquisitionSource, { error: "Choose how you acquired the item." }),
  acquisitionState: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().regex(/^[A-Z]{2}$/, { error: "Use a two-letter US state code." }).optional()),
  acquisitionYearApprox: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : Number(v)))
    .pipe(z.number().int({ error: "Enter a year." }).min(1500).optional()),
  acquisitionDetails: z
    .string()
    .trim()
    .min(20, { error: "Explain how and where you got the item (at least 20 characters)." })
    .max(2000),
  landownerName: optionalText(120),
  attestationKeys: z.array(z.string()),
  iacaAcknowledged: z.boolean(),
  signedName: z.string().trim().min(2, { error: "Type your full legal name to sign." }).max(120),
});

export type ListingSubmission = z.infer<typeof ListingSubmissionSchema>;

export interface RuleIssue {
  field: keyof ListingSubmission;
  message: string;
}

export interface RuleContext {
  category: { isNativeAmerican: boolean };
  attestations: Attestation[];
  verifiedLegalName: string;
  now: Date;
}

export function checkListingRules(input: ListingSubmission, ctx: RuleContext): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const need = (field: keyof ListingSubmission, ok: unknown, message: string) => {
    if (!ok) issues.push({ field, message });
  };

  if (ctx.category.isNativeAmerican) {
    need("regionOfOrigin", input.regionOfOrigin, "Native American items need the region of origin.");
    need("estimatedAge", input.estimatedAge, "Native American items need an estimated age or period.");
    need("materials", input.materials, "Native American items need the materials.");
    need("acquisitionState", input.acquisitionState, "Native American items need the state where you acquired it.");
    need("acquisitionYearApprox", input.acquisitionYearApprox, "Native American items need the approximate year you acquired it.");
    need("iacaAcknowledged", input.iacaAcknowledged, "Acknowledge the Indian Arts and Crafts Act disclosure.");
  }

  if (input.acquisitionSource === "PRIVATE_LAND_WITH_PERMISSION") {
    need("landownerName", input.landownerName, "Name the landowner who gave permission.");
    need("acquisitionState", input.acquisitionState, "Give the state where the land is.");
  }

  if (input.acquisitionYearApprox !== undefined && input.acquisitionYearApprox > ctx.now.getUTCFullYear()) {
    issues.push({ field: "acquisitionYearApprox", message: "Acquisition year can't be in the future." });
  }

  const accepted = new Set(input.attestationKeys);
  const missing = ctx.attestations.filter((a) => !accepted.has(a.key));
  need("attestationKeys", missing.length === 0, "Every statement must be checked to sign.");

  need(
    "signedName",
    legalNamesMatch(input.signedName, ctx.verifiedLegalName),
    "The signature must match the legal name on your verified ID.",
  );

  return issues;
}
