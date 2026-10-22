import { describe, expect, it } from "vitest";
import { formatUsd, parseUsdToCents, priceBreakdown } from "./pricing";

const rates = { buyerFeeBps: 1000, sellerFeeBps: 1000 };

describe("priceBreakdown", () => {
  it("rounds each fee to whole cents", () => {
    expect(priceBreakdown(1995, rates)).toMatchObject({
      buyerFeeCents: 200,
      buyerPriceCents: 2195,
      sellerFeeCents: 200,
      sellerPayoutCents: 1795,
      platformFeeCents: 400,
    });
  });

  it("rejects fractional or negative cents", () => {
    expect(() => priceBreakdown(10.5, rates)).toThrow(RangeError);
    expect(() => priceBreakdown(-1, rates)).toThrow(RangeError);
  });
});

describe("parseUsdToCents", () => {
  it.each([
    ["100", 10_000],
    ["$1,234.5", 123_450],
    ["0.99", 99],
    [" 12.00 ", 1200],
  ])("parses %s", (input, cents) => {
    expect(parseUsdToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "1.234", "-5", "1e3"])("rejects %s", (input) => {
    expect(parseUsdToCents(input)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats cents as dollars", () => {
    expect(formatUsd(11_000)).toBe("$110.00");
  });
});
