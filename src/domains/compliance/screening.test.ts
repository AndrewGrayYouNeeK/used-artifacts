import { describe, expect, it } from "vitest";
import { normalizeForScreening, screenFields, screeningTerms } from "./screening";

const reasons = (r: ReturnType<typeof screenFields>, key: "blocked" | "review") => r[key].map((m) => m.reason);

describe("prohibited-item screening", () => {
  it("blocks human remains, funerary objects, sacred objects, and cultural patrimony (NAGPRA)", () => {
    for (const text of [
      "Human remains, partial",
      "Lot includes a human skull fragment",
      "Funerary urn",
      "Grave goods from an old collection",
      "Beads dug from a burial mound",
      "Sacred object of the tribe",
      "Medicine bundle",
      "Object of cultural patrimony",
    ]) {
      expect(screenFields({ description: text }).blocked.length, text).toBeGreaterThan(0);
    }
  });

  it("blocks unverified Indian-made claims (IACA) and eagle parts", () => {
    expect(reasons(screenFields({ title: "Authentic Native American made basket" }), "blocked")).toContain(
      "Unverified Native American-made claim",
    );
    expect(screenFields({ title: "Old Indian‑made bracelet" }).blocked).toHaveLength(1);
    expect(screenFields({ title: "Bonnet with eagle feathers" }).blocked).toHaveLength(1);
  });

  it("sends ambiguous wording to review rather than blocking", () => {
    const r = screenFields({ title: "Ceremonial style pipe", description: "Not from national forest land" });
    expect(r.blocked).toEqual([]);
    expect(reasons(r, "review")).toEqual(
      expect.arrayContaining(["Possible sacred object", "Mentions federal land"]),
    );
  });

  it("matches whole words only, across case, spacing, and curly quotes", () => {
    expect(screenFields({ title: "Bonesetter's tool" }).review).toEqual([]);
    expect(screenFields({ title: "HUMAN    REMAINS" }).blocked).toHaveLength(1);
    expect(normalizeForScreening("It\u2019s  Indian\u2013made")).toBe("it's indian-made");
  });

  it("passes ordinary listings", () => {
    expect(
      screenFields({ title: "Archaic side-notched point", description: "Surface find on family farm, Ohio." }),
    ).toEqual({ blocked: [], review: [] });
  });

  it("lets staff add terms or tighten baseline terms, but never loosen a baseline block", () => {
    const terms = screeningTerms([
      { pattern: "funerary", isRegex: false, severity: "REVIEW", reason: "loosened" },
      { pattern: "ceremonial", isRegex: false, severity: "BLOCK", reason: "tightened" },
      { pattern: "reproduction", isRegex: false, severity: "REVIEW", reason: "added" },
    ]);
    expect(screenFields({ d: "funerary" }, terms).blocked).toHaveLength(1);
    expect(reasons(screenFields({ d: "ceremonial" }, terms), "blocked")).toEqual(["tightened"]);
    expect(reasons(screenFields({ d: "a reproduction" }, terms), "review")).toEqual(["added"]);
  });

  it("ignores an invalid staff regex instead of crashing submissions", () => {
    const terms = screeningTerms([{ pattern: "(", isRegex: true, severity: "BLOCK", reason: "broken" }]);
    expect(screenFields({ d: "(" }, terms).blocked).toEqual([]);
  });
});
