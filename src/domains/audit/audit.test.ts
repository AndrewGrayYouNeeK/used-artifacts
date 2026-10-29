import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeAuditHash } from "./audit";

const fields = {
  id: "evt-1",
  at: "2026-10-22T14:00:00.000Z",
  actorUserId: "u1",
  actorType: "USER" as const,
  action: "user.login",
  subjectType: "User",
  subjectId: "u1",
  before: null,
  after: { a: 1, b: 2 },
  ipHash: null,
  requestId: null,
};

describe("audit hash", () => {
  it("is deterministic and independent of JSON key order", () => {
    const reordered = { ...fields, after: { b: 2, a: 1 } };
    expect(computeAuditHash(GENESIS_HASH, fields)).toBe(computeAuditHash(GENESIS_HASH, reordered));
  });

  it("changes when any field or the previous hash changes", () => {
    const base = computeAuditHash(GENESIS_HASH, fields);
    expect(computeAuditHash(GENESIS_HASH, { ...fields, action: "user.logout" })).not.toBe(base);
    expect(computeAuditHash("f".repeat(64), fields)).not.toBe(base);
  });
});
