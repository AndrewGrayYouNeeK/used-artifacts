import type { FraudSignal } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/** Signal subjects are a User, Listing or Order; evidence may name more accounts (`*UserId` and `*UserIds` keys). */
function evidenceUserIds(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const ids: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (/userId$/i.test(key) && typeof value === "string") ids.push(value);
    else if (/userIds$/i.test(key) && Array.isArray(value)) ids.push(...value.filter((v): v is string => typeof v === "string"));
    else if (value && typeof value === "object") ids.push(...evidenceUserIds(value));
  }
  return ids;
}

/** The accounts each signal involves, so staff can open them and enforce from one place. */
export async function signalAccounts(db: Db, signals: Pick<FraudSignal, "id" | "subjectType" | "subjectId" | "evidence">[]) {
  const listingIds = signals.filter((s) => s.subjectType === "Listing").map((s) => s.subjectId);
  const orderIds = signals.filter((s) => s.subjectType === "Order").map((s) => s.subjectId);
  const [listings, orders] = await Promise.all([
    listingIds.length ? db.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, sellerUserId: true } }) : [],
    orderIds.length ? db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, buyerUserId: true, sellerUserId: true } }) : [],
  ]);
  const idsBySignal = new Map<string, string[]>();
  for (const s of signals) {
    const ids = new Set(evidenceUserIds(s.evidence));
    if (s.subjectType === "User") ids.add(s.subjectId);
    const listing = listings.find((l) => l.id === s.subjectId);
    if (s.subjectType === "Listing" && listing) ids.add(listing.sellerUserId);
    const order = orders.find((o) => o.id === s.subjectId);
    if (s.subjectType === "Order" && order) {
      ids.add(order.buyerUserId);
      ids.add(order.sellerUserId);
    }
    idsBySignal.set(s.id, [...ids]);
  }
  const allIds = [...new Set([...idsBySignal.values()].flat())];
  const users = allIds.length
    ? await db.user.findMany({ where: { id: { in: allIds } }, select: { id: true, displayName: true, email: true, status: true, role: true } })
    : [];
  return new Map(
    signals.map((s) => [s.id, (idsBySignal.get(s.id) ?? []).flatMap((id) => users.filter((u) => u.id === id))] as const),
  );
}

/** Open signals involving a user, found by subject or by evidence. */
export async function openSignalsForUser(db: Db, userId: string) {
  const open = await db.fraudSignal.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 500 });
  const accounts = await signalAccounts(db, open);
  return open.filter((s) => accounts.get(s.id)?.some((u) => u.id === userId));
}
