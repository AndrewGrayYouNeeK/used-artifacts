import { describe, expect, it } from "vitest";
import { screeningTerms } from "@/domains/compliance/screening";
import { applyGuardrails, type GuardrailContext } from "./guardrails";

const ctx: GuardrailContext = {
  categories: [
    { id: "cat-points", slug: "projectile-points", name: "Projectile Points", isNativeAmerican: true },
    { id: "cat-bottles", slug: "bottles", name: "Antique Bottles", isNativeAmerican: false },
  ],
  selectedCategoryId: "cat-bottles",
  screeningTerms: screeningTerms(),
};

const base = {
  suggestedCategorySlug: "bottles",
  identification: { label: "Blown glass bottle", confidence: 0.8 },
  suggestedTitle: "Aqua blown glass bottle",
  materials: "Glass",
  estimatedAge: "Late 1800s",
  regionOfOrigin: null,
  valueRangeUsd: { low: 20, high: 60 },
  observations: ["Pontil scar on the base"],
  redFlags: [],
  uncertainty: "LOW",
};

describe("photo analyzer guardrails", () => {
  it("passes clean output through, mapping the category slug to an id", () => {
    const g = applyGuardrails(base, ctx);
    expect(g.uncertainty).toBe("LOW");
    expect(g.normalized.suggestions).toEqual({
      categoryId: "cat-bottles",
      title: "Aqua blown glass bottle",
      materials: "Glass",
      estimatedAge: "Late 1800s",
    });
    expect(g.normalized.valueLowCents).toBe(2000);
    expect(g.normalized.valueHighCents).toBe(6000);
    expect(g.blocksPublishing).toBe(false);
    expect(g.guardrailActions).toEqual([]);
  });

  it("strips Indian-made and tribe-specific maker claims and forces HIGH uncertainty with the IACA disclosure", () => {
    const g = applyGuardrails(
      {
        ...base,
        suggestedTitle: "Authentic Navajo-made silver bracelet",
        identification: { label: "Bracelet made by the Navajo people", confidence: 0.9 },
        observations: ["Classic Indian-made stamp work", "Genuine Native American jewelry styling"],
      },
      ctx,
    );
    expect(g.normalized.suggestions.title).toBe("style/attribution unverified silver bracelet");
    expect(g.normalized.identification?.label).toBe("Bracelet style/attribution unverified");
    expect(g.normalized.observations.join(" ")).not.toMatch(/indian-made|navajo|genuine native american/i);
    expect(g.uncertainty).toBe("HIGH");
    expect(g.normalized.iacaDisclosure).toBe(true);
    expect(g.flags).toContain("NATIVE_AMERICAN_ATTRIBUTION");
    expect(g.guardrailActions).toEqual(expect.arrayContaining(["STRIPPED_MAKER_CLAIM", "FORCED_HIGH_UNCERTAINTY", "IACA_DISCLOSURE_ATTACHED"]));
    // The model's own maker claim was removed; it must not hold the listing as if the seller wrote it.
    expect(g.blocksPublishing).toBe(false);
  });

  it("forces HIGH uncertainty for a Native American category even when the text is neutral", () => {
    const g = applyGuardrails({ ...base, suggestedCategorySlug: null }, { ...ctx, selectedCategoryId: "cat-points" });
    expect(g.uncertainty).toBe("HIGH");
    expect(g.normalized.iacaDisclosure).toBe(true);
  });

  it("treats a cultural attribution (Adena, Hopewell) as unverified and HIGH", () => {
    const g = applyGuardrails({ ...base, suggestedTitle: "Adena-style blade", estimatedAge: "Possibly Early Woodland" }, ctx);
    expect(g.uncertainty).toBe("HIGH");
    expect(g.normalized.suggestions.title).toBe("Adena-style blade");
  });

  it("does not mangle ordinary words that contain a tribe name", () => {
    const g = applyGuardrails(
      { ...base, observations: ["An absolute made-to-order mold", "Canadian-made closure", "Made by hand, Crowley Glass Works mark"] },
      ctx,
    );
    expect(g.normalized.observations).toEqual(["An absolute made-to-order mold", "Canadian-made closure", "Made by hand, Crowley Glass Works mark"]);
    expect(g.guardrailActions).not.toContain("STRIPPED_MAKER_CLAIM");
  });

  it("never lets the analyzer authenticate or grade", () => {
    const g = applyGuardrails(
      {
        ...base,
        authenticated: true,
        gradingTier: "MUSEUM_GRADE",
        observations: ["This bottle is authentic and museum-grade", "Certified authentic by our model"],
      },
      ctx,
    );
    expect(g.normalized).not.toHaveProperty("authenticated");
    expect(g.normalized.observations.join(" ")).not.toMatch(/authentic|museum-grade|certified/i);
    expect(g.guardrailActions).toEqual(expect.arrayContaining(["DROPPED_AUTHENTICATION_FIELDS", "STRIPPED_AUTHENTICATION_CLAIM"]));
  });

  it("turns a point estimate into a range wide enough for the uncertainty", () => {
    const g = applyGuardrails({ ...base, uncertainty: "MEDIUM", valueRangeUsd: { low: 100, high: 100 } }, ctx);
    expect(g.normalized.valueLowCents).toBeLessThan(10_000);
    expect(g.normalized.valueHighCents).toBeGreaterThan(10_000);
    expect(g.normalized.valueHighCents! / g.normalized.valueLowCents!).toBeGreaterThanOrEqual(1.5);
    expect(g.guardrailActions).toContain("WIDENED_POINT_ESTIMATE");
  });

  it("widens a narrow range under HIGH uncertainty and swaps reversed bounds", () => {
    const g = applyGuardrails({ ...base, uncertainty: "HIGH", valueRangeUsd: { low: 120, high: 100 } }, ctx);
    expect(g.normalized.valueHighCents! / g.normalized.valueLowCents!).toBeGreaterThanOrEqual(2);
    expect(g.guardrailActions).toContain("WIDENED_VALUE_RANGE");
  });

  it("never lowers the model's uncertainty, and raises LOW when confidence is low", () => {
    expect(applyGuardrails({ ...base, uncertainty: "HIGH" }, ctx).uncertainty).toBe("HIGH");
    const g = applyGuardrails({ ...base, identification: { label: "Bottle", confidence: 0.3 } }, ctx);
    expect(g.uncertainty).toBe("MEDIUM");
    expect(g.flags).toContain("LOW_CONFIDENCE");
  });

  it("holds the listing for possible human remains, funerary, sacred, patrimony, or eagle parts", () => {
    for (const flag of ["POSSIBLE_HUMAN_REMAINS", "FUNERARY_INDICATORS", "SACRED_OR_CEREMONIAL", "CULTURAL_PATRIMONY", "PROTECTED_WILDLIFE_PARTS"]) {
      const g = applyGuardrails({ ...base, redFlags: [{ flag, evidence: "visible in photo 2" }] }, ctx);
      expect(g.blocksPublishing).toBe(true);
      expect(g.flags).toContain(flag);
      expect(g.uncertainty).not.toBe("LOW");
    }
    const reproduction = applyGuardrails({ ...base, redFlags: [{ flag: "POSSIBLE_REPRODUCTION", evidence: "casting seams" }] }, ctx);
    expect(reproduction.blocksPublishing).toBe(false);
    expect(reproduction.flags).toContain("POSSIBLE_REPRODUCTION");
  });

  it("holds the listing when the model's own description hits a block-level screening term", () => {
    const g = applyGuardrails({ ...base, observations: ["Appears to include human bone fragments"] }, ctx);
    expect(g.blocksPublishing).toBe(true);
    expect(g.normalized.screeningMatches[0]).toMatchObject({ blocking: true });
  });

  it("drops unknown categories and unknown red flags without trusting them", () => {
    const g = applyGuardrails({ ...base, suggestedCategorySlug: "antique-furniture", redFlags: [{ flag: "MADE_UP", evidence: "odd" }] }, ctx);
    expect(g.normalized.suggestions.categoryId).toBeUndefined();
    expect(g.normalized.redFlags).toEqual([]);
    expect(g.guardrailActions).toEqual(expect.arrayContaining(["DROPPED_UNKNOWN_CATEGORY", "IGNORED_UNKNOWN_RED_FLAG"]));
  });

  it("rejects malformed output as HIGH uncertainty with no suggestions", () => {
    for (const raw of [null, "free text", { uncertainty: "SURE" }, { ...base, valueRangeUsd: { low: -5, high: 10 } }]) {
      const g = applyGuardrails(raw, { ...ctx, selectedCategoryId: "cat-points" });
      expect(g.uncertainty).toBe("HIGH");
      expect(g.flags).toEqual(["INVALID_OUTPUT"]);
      expect(g.normalized.suggestions).toEqual({});
      expect(g.normalized.iacaDisclosure).toBe(true);
    }
  });
});
