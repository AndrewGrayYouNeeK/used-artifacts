import { describe, expect, it } from "vitest";
import { isVerticalEnabled, loadPlatformConfig } from "./platform";

describe("platform config", () => {
  it("opens only artifacts by default", () => {
    const cfg = loadPlatformConfig({});
    expect(cfg.enabledVerticals).toEqual(["ARTIFACT"]);
    expect(isVerticalEnabled("ARTIFACT", cfg)).toBe(true);
    expect(isVerticalEnabled("ANTIQUE", cfg)).toBe(false);
    expect(cfg.betaFounderLimit).toBe(100);
  });

  it("keeps auctions off unless explicitly enabled", () => {
    expect(loadPlatformConfig({}).auctionsEnabled).toBe(false);
    expect(loadPlatformConfig({ AUCTIONS_ENABLED: "true" }).auctionsEnabled).toBe(true);
    expect(() => loadPlatformConfig({ AUCTIONS_ENABLED: "yes" })).toThrow();
    expect(loadPlatformConfig({})).toMatchObject({ auctionSoftCloseMinutes: 2, auctionSellerDecisionDays: 3 });
  });

  it("keeps the closed-beta gates on by default", () => {
    expect(loadPlatformConfig({})).toMatchObject({ betaInviteRequired: true, staffTwoFactorRequired: true, dailyDigestHourUtc: 13 });
    expect(loadPlatformConfig({ BETA_INVITE_REQUIRED: "false" }).betaInviteRequired).toBe(false);
  });

  it("enables antiques via config", () => {
    const cfg = loadPlatformConfig({ ENABLED_VERTICALS: "artifact, antique" });
    expect(isVerticalEnabled("ANTIQUE", cfg)).toBe(true);
  });

  it("rejects unknown verticals", () => {
    expect(() => loadPlatformConfig({ ENABLED_VERTICALS: "ARTIFACT,FOSSIL" })).toThrow();
  });
});
