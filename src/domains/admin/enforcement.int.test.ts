import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createLiveListing, createVerifiedUser, testDb, testDeps } from "../../../test/helpers";
import { searchAuditEvents } from "@/domains/audit/audit";
import { browseListings } from "@/domains/listings/browse";
import {
  liftEnforcementAction,
  liftExpiredSuspensions,
  reviewFraudSignal,
  setUserRole,
  takeEnforcementAction,
} from "./enforcement";
import { openSignalsForUser } from "./signals";

const db = testDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const owner = () => createVerifiedUser(db, { role: "OWNER" });
const moderator = () => createVerifiedUser(db, { role: "MODERATOR" });

describe("database guards", () => {
  it("never lets an owner account be suspended or banned, even by direct SQL", async () => {
    const o = await owner();
    await expect(db.user.update({ where: { id: o.id }, data: { status: "BANNED" } })).rejects.toThrow(/owner/i);
  });

  it("keeps enforcement records append-only: no deletes, no edits, lifted once", async () => {
    const o = await owner();
    const target = await createVerifiedUser(db);
    const action = await db.enforcementAction.create({ data: { userId: target.id, type: "WARNING", reason: "Test warning", actorId: o.id } });
    await expect(db.enforcementAction.delete({ where: { id: action.id } })).rejects.toThrow();
    await expect(db.enforcementAction.update({ where: { id: action.id }, data: { reason: "Rewritten" } })).rejects.toThrow();
    await expect(db.enforcementAction.update({ where: { id: action.id }, data: { liftedAt: new Date() } })).rejects.toThrow();
    await db.enforcementAction.update({ where: { id: action.id }, data: { liftedAt: new Date(), liftReason: "Appeal granted" } });
    await expect(db.enforcementAction.update({ where: { id: action.id }, data: { liftReason: "Changed my mind" } })).rejects.toThrow();
  });

  it("requires the target of a listing removal and a short reason", async () => {
    const o = await owner();
    const target = await createVerifiedUser(db);
    await expect(db.enforcementAction.create({ data: { userId: target.id, type: "LISTING_REMOVED", reason: "Fake item", actorId: o.id } })).rejects.toThrow();
    await expect(db.enforcementAction.create({ data: { userId: target.id, type: "WARNING", reason: "x", actorId: o.id } })).rejects.toThrow();
  });
});

describe("enforcement", () => {
  it("suspends: signs the user out, hides their storefront, emails them, and lifts on appeal", async () => {
    const o = await owner();
    const { seller, listingId, categoryId } = await createLiveListing(db);
    const { slug } = await db.category.findUniqueOrThrow({ where: { id: categoryId } });
    expect((await browseListings(db, { category: slug })).total).toBe(1);
    await db.session.create({ data: { userId: seller.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + DAY) } });
    const deps = testDeps(db);

    const result = await takeEnforcementAction(deps, { actorId: o.id, userId: seller.id, type: "SUSPENSION", reason: "Shill bidding pattern", suspensionDays: 7 });
    expect(result).toMatchObject({ ok: true, listingsRemoved: 0 });
    expect(await db.user.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ status: "SUSPENDED" });
    expect(await db.session.count({ where: { userId: seller.id } })).toBe(0);
    expect(await db.storefront.findFirstOrThrow({ where: { ownerUserId: seller.id } })).toMatchObject({ status: "SUSPENDED" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listingId } })).toMatchObject({ status: "LIVE" });
    expect((await browseListings(db, { category: slug })).total).toBe(0);
    const { email } = await db.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(deps.mailer.sent.at(-1)).toMatchObject({ to: email, subject: expect.stringMatching(/suspended/) });

    if (!result.ok) throw new Error(result.reason);
    expect(await takeEnforcementAction(deps, { actorId: o.id, userId: seller.id, type: "SUSPENSION", reason: "Again", suspensionDays: 3 })).toMatchObject({
      ok: false,
      reason: "ALREADY_RESTRICTED",
    });
    expect(await liftEnforcementAction(deps, { actorId: o.id, enforcementId: result.enforcementId, reason: "Appeal: bids were from a spouse" })).toEqual({ ok: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.storefront.findFirstOrThrow({ where: { ownerUserId: seller.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await liftEnforcementAction(deps, { actorId: o.id, enforcementId: result.enforcementId, reason: "Second lift" })).toMatchObject({ reason: "ALREADY_LIFTED" });
  });

  it("ends suspensions automatically when their time is up", async () => {
    const o = await owner();
    const target = await createVerifiedUser(db);
    const start = Date.now();
    const result = await takeEnforcementAction(testDeps(db, () => new Date(start)), { actorId: o.id, userId: target.id, type: "SUSPENSION", reason: "Cooling off", suspensionDays: 2 });
    if (!result.ok) throw new Error(result.reason);

    await liftExpiredSuspensions({ db, now: () => new Date(start + DAY) });
    expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: "SUSPENDED" });
    await liftExpiredSuspensions({ db, now: () => new Date(start + 3 * DAY) });
    expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.enforcementAction.findUniqueOrThrow({ where: { id: result.enforcementId } })).toMatchObject({ liftReason: "Suspension period ended" });
    const events = await searchAuditEvents(db, { action: "enforcement.expired", subjectId: target.id });
    expect(events.events).toHaveLength(1);
  });

  it("bans: removes live listings, closes the storefront, and supersedes an open suspension", async () => {
    const o = await owner();
    const { seller, listingId } = await createLiveListing(db);
    const deps = testDeps(db);
    const suspension = await takeEnforcementAction(deps, { actorId: o.id, userId: seller.id, type: "SUSPENSION", reason: "Investigating", suspensionDays: 30 });
    if (!suspension.ok) throw new Error(suspension.reason);

    const ban = await takeEnforcementAction(deps, { actorId: o.id, userId: seller.id, type: "BAN", reason: "Sold reproductions as authentic" });
    expect(ban).toMatchObject({ ok: true, listingsRemoved: 1 });
    expect(await db.user.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ status: "BANNED" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listingId } })).toMatchObject({ status: "REMOVED" });
    expect(await db.listingOutcome.findUniqueOrThrow({ where: { listingId } })).toMatchObject({ outcome: "REMOVED" });
    expect(await db.storefront.findFirstOrThrow({ where: { ownerUserId: seller.id } })).toMatchObject({ status: "CLOSED" });
    expect(await db.enforcementAction.findUniqueOrThrow({ where: { id: suspension.enforcementId } })).toMatchObject({ liftReason: "Superseded by a ban" });
  });

  it("keeps account actions owner-only and protects the owner", async () => {
    const o = await owner();
    const mod = await moderator();
    const target = await createVerifiedUser(db);
    const deps = testDeps(db);
    expect(await takeEnforcementAction(deps, { actorId: mod.id, userId: target.id, type: "BAN", reason: "Moderator overreach" })).toMatchObject({ reason: "OWNER_ONLY" });
    expect(await takeEnforcementAction(deps, { actorId: mod.id, userId: o.id, type: "WARNING", reason: "Warn the owner" })).toMatchObject({ reason: "TARGET_IS_OWNER" });
    expect(await takeEnforcementAction(deps, { actorId: target.id, userId: mod.id, type: "WARNING", reason: "Not staff" })).toMatchObject({ reason: "NOT_STAFF" });
    expect(await takeEnforcementAction(deps, { actorId: o.id, userId: target.id, type: "SUSPENSION", reason: "Too long", suspensionDays: 400 })).toMatchObject({
      reason: "INVALID_DURATION",
    });
    expect(await takeEnforcementAction(deps, { actorId: mod.id, userId: target.id, type: "WARNING", reason: "Rude messages to buyers" })).toMatchObject({ ok: true });
    expect(deps.mailer.sent.at(-1)?.text).toContain("Rude messages to buyers");
  });

  it("removes a single listing and revokes and restores a badge", async () => {
    const mod = await moderator();
    const { seller, listingId } = await createLiveListing(db);
    const deps = testDeps(db);
    expect(await takeEnforcementAction(deps, { actorId: mod.id, userId: seller.id, type: "LISTING_REMOVED", reason: "Looted-site provenance", listingId })).toMatchObject({
      ok: true,
      listingsRemoved: 1,
    });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listingId } })).toMatchObject({ status: "REMOVED" });

    const badge = await db.badge.create({ data: { code: `TEST_${randomUUID()}`, name: "Test badge", kind: "VOLUME", description: "Test" } });
    const award = await db.userBadge.create({ data: { userId: seller.id, badgeId: badge.id } });
    const revoked = await takeEnforcementAction(deps, { actorId: mod.id, userId: seller.id, type: "BADGE_REVOKED", reason: "Volume came from linked accounts", userBadgeId: award.id });
    if (!revoked.ok) throw new Error(revoked.reason);
    expect((await db.userBadge.findUniqueOrThrow({ where: { id: award.id } })).revokedAt).not.toBeNull();
    expect(await liftEnforcementAction(deps, { actorId: mod.id, enforcementId: revoked.enforcementId, reason: "Accounts were unrelated" })).toEqual({ ok: true });
    expect((await db.userBadge.findUniqueOrThrow({ where: { id: award.id } })).revokedAt).toBeNull();
  });

  it("confirms the linked fraud signal and finds signals by evidence", async () => {
    const o = await owner();
    const { seller, listingId } = await createLiveListing(db);
    const signal = await db.fraudSignal.create({ data: { subjectType: "Listing", subjectId: listingId, detector: "SELF_RESALE", score: 70, evidence: {} } });
    const other = await db.fraudSignal.create({
      data: { subjectType: "Order", subjectId: randomUUID(), detector: "SHILL", score: 60, evidence: { bidderUserId: seller.id } },
    });
    const open = await openSignalsForUser(db, seller.id);
    expect(open.map((s) => s.id).sort()).toEqual([signal.id, other.id].sort());

    await takeEnforcementAction(testDeps(db), { actorId: o.id, userId: seller.id, type: "WARNING", reason: "Relisting a sold item", fraudSignalId: signal.id });
    expect(await db.fraudSignal.findUniqueOrThrow({ where: { id: signal.id } })).toMatchObject({ status: "CONFIRMED", reviewedById: o.id });

    expect(await reviewFraudSignal({ db }, { actorId: o.id, signalId: other.id, status: "DISMISSED", notes: "x" })).toMatchObject({ reason: "NOTES_REQUIRED" });
    expect(await reviewFraudSignal({ db }, { actorId: o.id, signalId: other.id, status: "DISMISSED", notes: "Bids were days apart" })).toEqual({ ok: true });
    expect(await reviewFraudSignal({ db }, { actorId: o.id, signalId: other.id, status: "CONFIRMED", notes: "Second look" })).toMatchObject({ reason: "ALREADY_REVIEWED" });
    expect(await openSignalsForUser(db, seller.id)).toHaveLength(0);
  });
});

describe("roles and audit", () => {
  it("lets only the owner promote and demote moderators, never to or from owner", async () => {
    const o = await owner();
    const mod = await moderator();
    const user = await createVerifiedUser(db);
    expect(await setUserRole({ db }, { actorId: mod.id, userId: user.id, role: "MODERATOR" })).toMatchObject({ reason: "OWNER_ONLY" });
    expect(await setUserRole({ db }, { actorId: o.id, userId: user.id, role: "MODERATOR" })).toEqual({ ok: true });
    expect(await setUserRole({ db }, { actorId: o.id, userId: user.id, role: "MODERATOR" })).toMatchObject({ reason: "UNCHANGED" });
    expect(await setUserRole({ db }, { actorId: o.id, userId: o.id, role: "USER" })).toMatchObject({ reason: "SELF_ACTION" });
    expect(await setUserRole({ db }, { actorId: o.id, userId: user.id, role: "USER" })).toEqual({ ok: true });

    const log = await searchAuditEvents(db, { action: "user.role_changed", subjectId: user.id });
    expect(log.events.map((e) => e.after)).toEqual([{ role: "USER" }, { role: "MODERATOR" }]);
    expect(log.events[0].actor?.email).toBe(o.email);
  });

  it("pages the audit log newest first", async () => {
    const o = await owner();
    const target = await createVerifiedUser(db);
    const deps = testDeps(db);
    for (const reason of ["First warning", "Second warning", "Third warning"]) {
      await takeEnforcementAction(deps, { actorId: o.id, userId: target.id, type: "WARNING", reason });
    }
    const first = await searchAuditEvents(db, { subjectId: target.id, actorUserId: o.id, limit: 2 });
    expect(first.events.map((e) => (e.after as { reason: string }).reason)).toEqual(["Third warning", "Second warning"]);
    expect(first.nextBeforeSeq).not.toBeNull();
    const second = await searchAuditEvents(db, { subjectId: target.id, actorUserId: o.id, limit: 2, beforeSeq: first.nextBeforeSeq! });
    expect(second.events.map((e) => (e.after as { reason: string }).reason)).toEqual(["First warning"]);
    expect(second.nextBeforeSeq).toBeNull();
  });
});
