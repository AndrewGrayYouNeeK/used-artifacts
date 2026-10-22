import type { Db } from "@/lib/db";
import type { BadgeKind } from "@/generated/prisma/enums";

export interface PublicBadge {
  code: string;
  name: string;
  kind: BadgeKind;
}

/** The only user data that may be rendered next to someone's name in public UI. */
export interface PublicIdentity {
  userId: string;
  displayName: string;
  isProprietor: boolean;
  badges: PublicBadge[];
}

export async function getPublicIdentities(
  db: Db,
  userIds: string[],
): Promise<Map<string, PublicIdentity>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();

  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      displayName: true,
      proprietor: { select: { id: true } },
      badges: {
        where: { revokedAt: null },
        select: { badge: { select: { code: true, name: true, kind: true } } },
        orderBy: { awardedAt: "asc" },
      },
    },
  });

  return new Map(
    users.map((u) => [
      u.id,
      {
        userId: u.id,
        displayName: u.displayName,
        isProprietor: u.proprietor !== null,
        badges: u.badges.map((b) => b.badge),
      },
    ]),
  );
}

export async function getPublicIdentity(db: Db, userId: string): Promise<PublicIdentity | null> {
  return (await getPublicIdentities(db, [userId])).get(userId) ?? null;
}
