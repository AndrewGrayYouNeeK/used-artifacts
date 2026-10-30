import { Suspense } from "react";
import { connection } from "next/server";
import { platform } from "@/config/platform";
import Image from "next/image";
import Link from "next/link";
import { ListingCard } from "@/components/listing-card";
import { browseListings } from "@/domains/listings/browse";
import { db } from "@/lib/db";

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
      <section className="flex flex-col items-center gap-8 text-center md:flex-row-reverse md:items-center md:justify-between md:gap-12 md:text-left">
        <Image
          src="/logo.webp"
          alt="Used Artifacts logo"
          width={640}
          height={640}
          priority
          sizes="(min-width: 768px) 320px, 224px"
          className="h-56 w-56 shrink-0 drop-shadow-xl md:h-80 md:w-80"
        />
        <div className="max-w-2xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">
            Closed beta
          </p>
          <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Artifacts with a paper trail.
          </h1>
          <p className="mt-5 text-base text-stone-600 sm:text-lg">
            Every seller is ID-verified and signs a provenance statement for every piece. Payment is
            held until you confirm delivery. High-value pieces are checked by independent
            authenticators.
          </p>
        </div>
      </section>

      <section className="mt-16">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-serif text-xl font-semibold">Recently listed</h2>
          <Link href="/browse" className="text-sm underline">
            Browse all
          </Link>
        </div>
        <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-stone-100" />}>
          <RecentListings />
        </Suspense>
      </section>

      <section className="mt-16">
        <h2 className="mb-4 font-serif text-xl font-semibold">Browse categories</h2>
        <Suspense fallback={<div className="h-24 animate-pulse rounded-xl bg-stone-100" />}>
          <CategoryGrid />
        </Suspense>
        {!platform.enabledVerticals.includes("ANTIQUE") && (
          <p className="mt-4 text-sm text-stone-500">
            Antiques open once our grading program launches.
          </p>
        )}
      </section>
    </div>
  );
}

async function CategoryGrid() {
  await connection();
  const categories = await db.category.findMany({
    where: { parentId: null, vertical: { in: platform.enabledVerticals } },
    orderBy: { sortOrder: "asc" },
    select: { id: true, slug: true, name: true, isNativeAmerican: true, children: { select: { id: true } } },
  });
  if (categories.length === 0) {
    return <p className="text-sm text-stone-500">No categories yet. Run the database seed.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {categories.map((c) => (
        <li key={c.id}>
          <Link
            href={`/browse?category=${c.slug}`}
            className="block rounded-xl border border-stone-200 bg-white px-4 py-4 shadow-sm hover:border-stone-400"
          >
            <span className="font-medium">{c.name}</span>
            <span className="mt-1 block text-xs text-stone-500">
              {c.children.length} subcategories
              {c.isNativeAmerican && " · enhanced review"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function RecentListings() {
  await connection();
  const { listings } = await browseListings(db, {});
  if (listings.length === 0) return <p className="text-sm text-stone-500">The first pieces are in review.</p>;
  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {listings.slice(0, 8).map((l) => (
        <li key={l.id}>
          <ListingCard listing={l} />
        </li>
      ))}
    </ul>
  );
}
