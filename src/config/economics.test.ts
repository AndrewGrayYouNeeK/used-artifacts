import { describe, expect, it } from "vitest";
import { loadEconomicsConfig, platformFeeCents, referralPayout, splitSale } from "./economics";

const defaults = loadEconomicsConfig({});
const SALE = 10_000;

describe("economics config", () => {
  it("defaults to Andrew's decisions", () => {
    expect(defaults.platformFeeBps).toEqual({ FREE: 1000, PAID: 500 });
    expect(defaults.paidTierPriceCents).toBe(2000);
    expect(defaults.referralBps).toBe(500);
    expect(defaults.referralCapAtPlatformFee).toBe(true);
    expect(defaults.escrowAutoReleaseDays).toBe(3);
    expect(defaults.auctionPaymentWindowHours).toBe(48);
  });

  it("reads overrides from env", () => {
    const cfg = loadEconomicsConfig({
      PLATFORM_FEE_BPS_FREE: "800",
      REFERRAL_BPS: "300",
      REFERRAL_CAP_AT_PLATFORM_FEE: "false",
    });
    expect(cfg.platformFeeBps.FREE).toBe(800);
    expect(cfg.referralBps).toBe(300);
    expect(cfg.referralCapAtPlatformFee).toBe(false);
  });

  it("rejects out-of-range rates", () => {
    expect(() => loadEconomicsConfig({ PLATFORM_FEE_BPS_FREE: "20000" })).toThrow();
    expect(() => loadEconomicsConfig({ REFERRAL_BPS: "-1" })).toThrow();
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

describe("referral: flat 5% of the sale price on every recruit sale (BUILD_PLAN 0.2)", () => {
  it("free-tier recruit: referrer gets 5%, platform nets 5% on every sale including the first", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "FREE", referred: true }, defaults);
    expect(s.referral).toMatchObject({ rateBps: 500, basisCents: SALE, amountCents: 500, cappedAtFee: false });
    expect(s.platformNetCents).toBe(500);
  });

  it("paid-tier recruit: referral equals the 5% fee, platform nets 0% on every sale", () => {
    const s = splitSale({ saleCents: SALE, sellerTier: "PAID", referred: true }, defaults);
    expect(s.referral?.amountCents).toBe(500);
    expect(s.referral?.cappedAtFee).toBe(false);
    expect(s.platformNetCents).toBe(0);
  });

  it("not referred: platform keeps the whole fee", () => {
    expect(splitSale({ saleCents: SALE, sellerTier: "FREE", referred: false }, defaults).platformNetCents).toBe(1000);
  });

  it("the cap stops a payout from exceeding the fee collected on that sale", () => {
    const cfg = loadEconomicsConfig({ REFERRAL_BPS: "800" });
    const s = splitSale({ saleCents: SALE, sellerTier: "PAID", referred: true }, cfg);
    expect(s.referral).toMatchObject({ amountCents: 500, cappedAtFee: true });
    expect(s.platformNetCents).toBe(0);
  });

  it("with the cap off, a referral larger than the fee would cost the platform money", () => {
    const cfg = loadEconomicsConfig({ REFERRAL_BPS: "800", REFERRAL_CAP_AT_PLATFORM_FEE: "false" });
    expect(splitSale({ saleCents: SALE, sellerTier: "PAID", referred: true }, cfg).platformNetCents).toBe(-300);
  });

  it("seller proceeds never include the referral", () => {
    expect(splitSale({ saleCents: SALE, sellerTier: "FREE", referred: true }, defaults).sellerProceedsCents).toBe(9000);
  });

  it("rounds to whole cents", () => {
    expect(referralPayout({ saleCents: 1999, platformFeeCents: 200 }, defaults).amountCents).toBe(100);
  });
});
