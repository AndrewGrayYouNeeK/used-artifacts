import { afterAll, describe, expect, it } from "vitest";
import { audit, verifyAuditChain } from "./audit";
import { testDb } from "../../../test/helpers";

const db = testDb();
afterAll(() => db.$disconnect());

describe("audit log", () => {
  it("keeps an intact hash chain under concurrent writes", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit(db, {
          actorType: "SYSTEM",
          action: "test.concurrent",
          subjectType: "Test",
          subjectId: String(i),
          after: { i, nested: { z: 1, a: 2 } },
        }),
      ),
    );
    const result = await verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(10);
  });

  it("is append-only at the database level", async () => {
    const event = await audit(db, { actorType: "SYSTEM", action: "test.immutable", subjectType: "Test" });
    await expect(
      db.auditEvent.update({ where: { seq: event.seq }, data: { action: "tampered" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { seq: event.seq } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe('TRUNCATE "AuditEvent"')).rejects.toThrow(/append-only/);
  });
});
