import { describe, expect, it } from "vitest";
import { loadEconomicsConfig, splitSale } from "./economics";

const defaults = loadEconomicsConfig({});
const ASKING = 10_000;

describe("economics config", () => {
  it("defaults to Andrew's decisions", () => {
    expect(defaults).toMatchObject({
      buyerFeeBps: 1000,
      sellerFeeBps: 1000,
      referralBps: 500,
      referralBasis: "BUYER_PRICE",
      referralCapAtPlatformFee: true,
      escrowAutoReleaseDays: 3,
      auctionPaymentWindowHours: 48,
    });
  });

  it("has no paid-tier settings", () => {
    expect(Object.keys(defaults).some((k) => /tier|paid|subscription/i.test(k))).toBe(false);
  });

  it("reads overrides from env", () => {
    const cfg = loadEconomicsConfig({
      BUYER_FEE_BPS: "800",
      SELLER_FEE_BPS: "700",
      REFERRAL_BPS: "300",
      REFERRAL_BASIS: "ASKING_PRICE",
      REFERRAL_CAP_AT_PLATFORM_FEE: "false",
    });
    expect(cfg).toMatchObject({
      buyerFeeBps: 800,
      sellerFeeBps: 700,
      referralBps: 300,
      referralBasis: "ASKING_PRICE",
      referralCapAtPlatformFee: false,
    });
  });

  it("rejects invalid values", () => {
    expect(() => loadEconomicsConfig({ BUYER_FEE_BPS: "20000" })).toThrow();
    expect(() => loadEconomicsConfig({ REFERRAL_BPS: "-1" })).toThrow();
    expect(() => loadEconomicsConfig({ REFERRAL_BASIS: "PROFIT" })).toThrow();
  });
});

describe("two-sided 10% fees (BUILD_PLAN 0.2)", () => {
  it("$100 asking: buyer sees and pays $110, seller gets $90, platform takes $20", () => {
    const s = splitSale({ askingCents: ASKING, referred: false }, defaults);
    expect(s).toMatchObject({
      askingCents: 10_000,
      buyerFeeCents: 1000,
      buyerPriceCents: 11_000,
      sellerFeeCents: 1000,
      sellerPayoutCents: 9000,
      platformFeeCents: 2000,
      referral: null,
      platformNetCents: 2000,
    });
  });

  it("money balances: buyer price = seller payout + platform fee", () => {
    for (const asking of [1, 99, 1234, 99_999]) {
      const s = splitSale({ askingCents: asking, referred: false }, defaults);
      expect(s.buyerPriceCents).toBe(s.sellerPayoutCents + s.platformFeeCents);
    }
  });
});

describe("referral: flat 5% of the sale on every recruit sale, paid from the platform's take", () => {
  it("default basis is the buyer price: $5.50 on a $110 sale, platform nets $14.50", () => {
    const s = splitSale({ askingCents: ASKING, referred: true }, defaults);
    expect(s.referral).toMatchObject({ basis: "BUYER_PRICE", basisCents: 11_000, amountCents: 550, cappedAtFee: false });
    expect(s.platformNetCents).toBe(1450);
    expect(s.sellerPayoutCents).toBe(9000);
  });

  it("asking-price basis: $5.00, platform nets $15.00", () => {
    const cfg = loadEconomicsConfig({ REFERRAL_BASIS: "ASKING_PRICE" });
    const s = splitSale({ askingCents: ASKING, referred: true }, cfg);
    expect(s.referral?.amountCents).toBe(500);
    expect(s.platformNetCents).toBe(1500);
  });

  it("the cap stops a payout from exceeding the platform's take on that sale", () => {
    const cfg = loadEconomicsConfig({ REFERRAL_BPS: "2500" });
    const s = splitSale({ askingCents: ASKING, referred: true }, cfg);
    expect(s.referral).toMatchObject({ amountCents: 2000, cappedAtFee: true });
    expect(s.platformNetCents).toBe(0);
  });

  it("with the cap off, an oversized referral would cost the platform money", () => {
    const cfg = loadEconomicsConfig({ REFERRAL_BPS: "2500", REFERRAL_CAP_AT_PLATFORM_FEE: "false" });
    expect(splitSale({ askingCents: ASKING, referred: true }, cfg).platformNetCents).toBe(-750);
  });
});
