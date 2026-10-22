import { afterAll, describe, expect, it } from "vitest";
import { assignProprietor, getProprietorUserId, ProprietorAlreadyAssignedError } from "./proprietor";
import { getPublicIdentity } from "./public-identity";
import { createVerifiedUser, testDb } from "../../../test/helpers";

const db = testDb();
afterAll(() => db.$disconnect());

// The Proprietor table is a global singleton, so these steps run in order in one file.
describe("Proprietor badge: exactly one holder, ever", () => {
  it("the database refuses to give it to a non-owner", async () => {
    const user = await createVerifiedUser(db);
    await expect(db.proprietor.create({ data: { userId: user.id } })).rejects.toThrow(
      /platform owner/,
    );
  });

  it("the database refuses any id other than 1", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    await expect(db.proprietor.create({ data: { id: 2, userId: owner.id } })).rejects.toThrow();
  });

  let andrewId = "";

  it("assignProprietor promotes the account to OWNER and assigns the badge once", async () => {
    const andrew = await createVerifiedUser(db, { email: "Andrew@UsedArtifacts.test" });
    andrewId = andrew.id;
    const row = await assignProprietor(db, "  andrew@usedartifacts.test ");
    expect(row.userId).toBe(andrew.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: andrew.id } })).role).toBe("OWNER");
    expect(await getProprietorUserId(db)).toBe(andrew.id);

    const identity = await getPublicIdentity(db, andrew.id);
    expect(identity?.isProprietor).toBe(true);

    const event = await db.auditEvent.findFirstOrThrow({ where: { action: "proprietor.assigned" } });
    expect(event.subjectId).toBe(andrew.id);
  });

  it("cannot be assigned a second time, even to another owner", async () => {
    const otherOwner = await createVerifiedUser(db, { role: "OWNER" });
    await expect(assignProprietor(db, otherOwner.email)).rejects.toBeInstanceOf(
      ProprietorAlreadyAssignedError,
    );
    await expect(db.proprietor.create({ data: { userId: otherOwner.id } })).rejects.toThrow();
    expect((await getPublicIdentity(db, otherOwner.id))?.isProprietor).toBe(false);
  });

  it("cannot be moved to someone else", async () => {
    const otherOwner = await createVerifiedUser(db, { role: "OWNER" });
    await expect(
      db.proprietor.update({ where: { id: 1 }, data: { userId: otherOwner.id } }),
    ).rejects.toThrow(/permanent/);
  });

  it("cannot be deleted or truncated", async () => {
    await expect(db.proprietor.delete({ where: { id: 1 } })).rejects.toThrow(/permanent/);
    await expect(db.$executeRawUnsafe('TRUNCATE "Proprietor"')).rejects.toThrow(/permanent/);
  });

  it("the Proprietor cannot be demoted from OWNER or deleted", async () => {
    await expect(db.user.update({ where: { id: andrewId }, data: { role: "USER" } })).rejects.toThrow(
      /OWNER/,
    );
    await expect(db.user.delete({ where: { id: andrewId } })).rejects.toThrow();
    expect(await getProprietorUserId(db)).toBe(andrewId);
  });
});
