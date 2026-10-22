import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "@/lib/crypto";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp";

const RFC_SECRET = Buffer.from("12345678901234567890");
const rfcBase32 = base32Encode(RFC_SECRET);

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(rfcBase32, new Date(seconds * 1000))).toBe(code);
    }
    expect(hotp(RFC_SECRET, 0)).toBe("755224");
  });

  it("round-trips base32", () => {
    expect(base32Decode(rfcBase32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it("accepts one step of drift and refuses replays", () => {
    const now = new Date(1_800_000_000_000);
    const secret = generateTotpSecret();
    const step = totpStep(now);
    const previous = totpCode(secret, new Date(now.getTime() - 30_000));
    expect(verifyTotp(secret, totpCode(secret, now), now, null)).toBe(step);
    expect(verifyTotp(secret, previous, now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 90_000)), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now), now, step)).toBeNull();
    expect(verifyTotp(secret, previous, now, step - 1)).toBeNull();
    expect(verifyTotp(secret, "12345", now, null)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now, null)).toBeNull();
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const uri = otpauthUri({ issuer: "Used Artifacts", account: "andrew@example.com", secret: "JBSWY3DPEHPK3PXP" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Used%20Artifacts%3Aandrew%40example\.com\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Used+Artifacts");
  });

  it("generates distinct recovery codes and normalizes typed ones", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(looksLikeRecoveryCode(c)).toBe(true);
    expect(normalizeRecoveryCode(" K7M2P X9QRT ")).toBe("k7m2p-x9qrt");
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});

describe("encryptString", () => {
  it("round-trips and detects tampering or the wrong key", () => {
    const sealed = encryptString("key-material-key-material-key-material", "JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptString("key-material-key-material-key-material", sealed)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptString("another-key-another-key-another-key", sealed)).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptString("key-material-key-material-key-material", parts.join("."))).toThrow();
  });
});
