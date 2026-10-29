import { describe, expect, it } from "vitest";
import { PROVENANCE_TEMPLATE_V2, DRAFT_BANNER } from "@/domains/compliance/provenance-template";
import { legalNamesMatch } from "@/domains/identity/legal-name";
import { ListingSubmissionSchema, checkListingRules, type ListingSubmission } from "./rules";

const allKeys = PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key);
const ctx = (isNativeAmerican = false) => ({
  category: { isNativeAmerican },
  attestations: PROVENANCE_TEMPLATE_V2.attestations,
  verifiedLegalName: "José Álvarez",
  now: new Date("2026-10-22T00:00:00Z"),
});

const raw = {
  categoryId: "cat",
  title: "Historic bottle",
  description: "Embossed amber bottle, no chips or cracks.",
  askingPrice: "$1,250.50",
  regionOfOrigin: "",
  estimatedAge: "",
  materials: "",
  sellerConditionGrade: "",
  acquisitionSource: "PURCHASED",
  acquisitionState: "oh",
  acquisitionYearApprox: "2001",
  acquisitionDetails: "Bought at an estate sale in Columbus, receipt kept.",
  landownerName: "",
  attestationKeys: allKeys,
  iacaAcknowledged: false,
  signedName: "jose alvarez",
};

const parse = (overrides: Record<string, unknown> = {}): ListingSubmission =>
  ListingSubmissionSchema.parse({ ...raw, ...overrides });

describe("listing submission schema", () => {
  it("parses the asking price into cents and normalizes optional fields", () => {
    const s = parse();
    expect(s.askingPrice).toBe(125_050);
    expect(s.acquisitionState).toBe("OH");
    expect(s.acquisitionYearApprox).toBe(2001);
    expect(s.materials).toBeUndefined();
  });

  it("rejects bad prices", () => {
    expect(ListingSubmissionSchema.safeParse({ ...raw, askingPrice: "12.345" }).success).toBe(false);
    expect(ListingSubmissionSchema.safeParse({ ...raw, askingPrice: "0.50" }).success).toBe(false);
    expect(ListingSubmissionSchema.safeParse({ ...raw, askingPrice: "abc" }).success).toBe(false);
  });
});

describe("listing rules", () => {
  it("passes a complete general listing", () => {
    expect(checkListingRules(parse(), ctx())).toEqual([]);
  });

  it("requires landowner and state for private-land finds", () => {
    const issues = checkListingRules(
      parse({ acquisitionSource: "PRIVATE_LAND_WITH_PERMISSION", acquisitionState: "" }),
      ctx(),
    );
    expect(issues.map((i) => i.field).sort()).toEqual(["acquisitionState", "landownerName"]);
  });

  it("requires Native American details and the IACA acknowledgement", () => {
    const fields = checkListingRules(parse(), ctx(true)).map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(["regionOfOrigin", "estimatedAge", "materials", "iacaAcknowledged"]),
    );
  });

  it("rejects future acquisition years, missing attestations, and mismatched signatures", () => {
    const issues = checkListingRules(
      parse({ acquisitionYearApprox: "2031", attestationKeys: allKeys.slice(0, 2), signedName: "Joe Alvarez" }),
      ctx(),
    );
    expect(issues.map((i) => i.field).sort()).toEqual(["acquisitionYearApprox", "attestationKeys", "signedName"]);
  });
});

describe("legal name matching", () => {
  it("ignores case, accents, punctuation, and spacing", () => {
    expect(legalNamesMatch("  JOSE   alvarez. ", "José Álvarez")).toBe(true);
    expect(legalNamesMatch("Mary-Kate O'Neil", "mary-kate o'neil")).toBe(true);
  });

  it("does not match different or empty names", () => {
    expect(legalNamesMatch("Jose", "José Álvarez")).toBe(false);
    expect(legalNamesMatch("...", "...")).toBe(false);
  });
});

describe("provenance template v2", () => {
  it("is visibly marked as a draft pending lawyer review", () => {
    expect(PROVENANCE_TEMPLATE_V2.body.startsWith(DRAFT_BANNER)).toBe(true);
    expect(DRAFT_BANNER).toMatch(/PENDING LAWYER REVIEW/);
  });

  it("covers government and tribal land, NAGPRA bans, and IACA", () => {
    const text = PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.text).join(" ");
    for (const phrase of ["national forest", "tribal", "human remains", "funerary", "sacred", "Indian-made"]) {
      expect(text).toContain(phrase);
    }
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});
