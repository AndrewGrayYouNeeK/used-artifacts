import type { Db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { platform, type PlatformConfig } from "@/config/platform";

export const BROWSE_PAGE_SIZE = 24;

export interface BrowseQuery {
  q?: string;
  /** A top-level or leaf category slug. */
  category?: string;
  page?: number;
}

/** Live listings in enabled verticals only (antiques stay hidden until ENABLED_VERTICALS includes them). */
export async function browseListings(db: Db, query: BrowseQuery, config: PlatformConfig = platform) {
  const terms = (query.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const where: Prisma.ListingWhereInput = {
    status: "LIVE",
    storefront: { status: "ACTIVE" },
    ...(config.auctionsEnabled ? {} : { format: "FIXED" as const }),
    category: {
      vertical: { in: config.enabledVerticals },
      ...(query.category ? { OR: [{ slug: query.category }, { parent: { slug: query.category } }] } : {}),
    },
    AND: terms.map((t) => ({
      OR: [
        { title: { contains: t, mode: "insensitive" as const } },
        { description: { contains: t, mode: "insensitive" as const } },
        { materials: { contains: t, mode: "insensitive" as const } },
        { regionOfOrigin: { contains: t, mode: "insensitive" as const } },
      ],
    })),
  };
  const page = Math.max(1, query.page ?? 1);
  const [listings, total] = await Promise.all([
    db.listing.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      take: BROWSE_PAGE_SIZE,
      skip: (page - 1) * BROWSE_PAGE_SIZE,
      include: {
        photos: { orderBy: { sortOrder: "asc" }, take: 1 },
        storefront: { select: { name: true } },
        auctions: { where: { status: "LIVE" }, take: 1, select: { currentPriceCents: true, startingBidCents: true } },
      },
    }),
    db.listing.count({ where }),
  ]);
  return { listings, total, page, pages: Math.max(1, Math.ceil(total / BROWSE_PAGE_SIZE)) };
}

export type BrowseListing = Awaited<ReturnType<typeof browseListings>>["listings"][number];
