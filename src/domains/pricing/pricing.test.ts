import { describe, expect, it } from "vitest";
import { formatUsd, parseUsdToCents, priceBreakdown, splitBuyerPrice } from "./pricing";

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

describe("splitBuyerPrice", () => {
  it("inverts priceBreakdown for prices it produced", () => {
    for (const asking of [100, 1_995, 10_000, 123_457]) {
      expect(splitBuyerPrice(priceBreakdown(asking, rates).buyerPriceCents, rates)).toEqual(priceBreakdown(asking, rates));
    }
  });

  it("charges exactly the winning bid and keeps the fee identities", () => {
    for (const bid of [101, 5_200, 5_201, 99_999, 1_234_567]) {
      const p = splitBuyerPrice(bid, rates);
      expect(p.buyerPriceCents).toBe(bid);
      expect(p.askingCents + p.buyerFeeCents).toBe(bid);
      expect(p.sellerPayoutCents).toBe(p.askingCents - p.sellerFeeCents);
      expect(Math.abs(p.buyerFeeCents - Math.round(p.askingCents / 10))).toBeLessThanOrEqual(1);
    }
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
