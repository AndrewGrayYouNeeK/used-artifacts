import { describe, expect, it } from "vitest";
import { loadEconomicsConfig, platformFeeCents, referralPayout, splitSale } from "./economics";

const defaults = loadEconomicsConfig({});
const SALE = 10_000;

describe("economics config", () => {
  it("defaults to Andrew's decisions", () => {
    expect(defaults.platformFeeBps).toEqual({ FREE: 1000, PAID: 500 });
    expect(defaults.paidTierPriceCents).toBe(2000);
    expect(defaults.referralFirstSaleBps).toBe(1000);
    expect(defaults.referralOngoingBps).toBe(500);
    expect(defaults.referralCapAtPlatformFee).toBe(true);
    expect(defaults.escrowAutoReleaseDays).toBe(3);
    expect(defaults.auctionPaymentWindowHours).toBe(48);
  });

  it("reads overrides from env", () => {
    const cfg = loadEconomicsConfig({
      PLATFORM_FEE_BPS_FREE: "800",
      REFERRAL_CAP_AT_PLATFORM_FEE: "false",
    });
    expect(cfg.platformFeeBps.FREE).toBe(800);
    expect(cfg.referralCapAtPlatformFee).toBe(false);
  });

  it("rejects out-of-range rates", () => {
    expect(() => loadEconomicsConfig({ PLATFORM_FEE_BPS_FREE: "20000" })).toThrow();
  });
});

describe("platform fee", () => {
  it("is 10% for free sellers and 5% for paid sellers", () => {
    expect(platformFeeCents(SALE, "FREE", defaults)).toBe(1000);
    expect(platformFeeCents(SALE, "PAID", defaults)).toBe(500);
  });

  it("rejects non-integer cents", () => {
    expect(() => platformFeeCents(10.5, "FREE", defaults)).toThrow(RangeError);
  });
});

describe("referral payouts are a share of the sale price (BUILD_PLAN 0.2)", () => {
  it("free seller first sale: platform nets 0%", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "FREE", referralKind: "FIRST_SALE" }, defaults);
    expect(s.referral?.amountCents).toBe(1000);
    expect(s.platformNetCents).toBe(0);
  });

  it("free seller ongoing sales: platform nets 5%", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "FREE", referralKind: "ONGOING" }, defaults);
    expect(s.referral?.amountCents).toBe(500);
    expect(s.platformNetCents).toBe(500);
  });

  it("paid seller ongoing sales: platform nets 0%", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "PAID", referralKind: "ONGOING" }, defaults);
    expect(s.platformNetCents).toBe(0);
  });

  it("paid seller first sale: capped at the fee, so platform nets 0% instead of -5%", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "PAID", referralKind: "FIRST_SALE" }, defaults);
    expect(s.referral).toMatchObject({ amountCents: 500, cappedAtFee: true, basisCents: SALE });
    expect(s.platformNetCents).toBe(0);
  });

  it("without the cap, paid seller first sale costs the platform 5%", () => {
    const uncapped = loadEconomicsConfig({ REFERRAL_CAP_AT_PLATFORM_FEE: "false" });
    const s = splitSale({ saleCents: SALE, sellerTier: "PAID", referralKind: "FIRST_SALE" }, uncapped);
    expect(s.platformNetCents).toBe(-500);
  });

  it("seller proceeds never include the referral", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "FREE", referralKind: "FIRST_SALE" }, defaults);
    expect(s.sellerProceedsCents).toBe(9000);
  });

  it("reports the rate used", () => {
    expect(referralPayout({ saleCents: SALE, platformFeeCents: 1000, kind: "ONGOING" }, defaults).rateBps).toBe(500);
  });
});
