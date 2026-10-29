import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { platform } from "@/config/platform";
import { inputClass } from "@/components/action-form";
import { ListingCard } from "@/components/listing-card";
import { browseListings } from "@/domains/listings/browse";
import { db } from "@/lib/db";

export default function BrowsePage({ searchParams }: PageProps<"/browse">) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-serif text-3xl font-semibold">Browse</h1>
      <Suspense fallback={<div className="mt-6 h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Results searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function Results({ searchParams }: { searchParams: PageProps<"/browse">["searchParams"] }) {
  await connection();
  const params = await searchParams;
  const q = one(params.q) ?? "";
  const category = one(params.category) ?? "";
  const page = Number(one(params.page) ?? "1") || 1;
  const [categories, result] = await Promise.all([
    db.category.findMany({
      where: { parentId: null, vertical: { in: platform.enabledVerticals } },
      orderBy: { sortOrder: "asc" },
      select: { slug: true, name: true },
    }),
    browseListings(db, { q, category: category || undefined, page }),
  ]);
  const pageHref = (p: number) => `/browse?${new URLSearchParams({ q, category, page: String(p) })}`;

  return (
    <div className="mt-6 space-y-6">
      <form className="grid gap-3 sm:grid-cols-[1fr_14rem_auto]" role="search">
        <input name="q" defaultValue={q} placeholder="Search titles, materials, regions…" className={inputClass} />
        <select name="category" defaultValue={category} className={inputClass}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
          Search
        </button>
      </form>
      <p className="text-sm text-stone-500">
        {result.total} {result.total === 1 ? "piece" : "pieces"}
      </p>
      {result.listings.length === 0 ? (
        <p className="text-sm text-stone-600">Nothing matches yet. Try fewer words or another category.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {result.listings.map((l) => (
            <li key={l.id}>
              <ListingCard listing={l} />
            </li>
          ))}
        </ul>
      )}
      {result.pages > 1 && (
        <nav className="flex justify-between text-sm">
          {result.page > 1 ? <Link href={pageHref(result.page - 1)} className="underline">Previous</Link> : <span />}
          <span className="text-stone-500">
            Page {result.page} of {result.pages}
          </span>
          {result.page < result.pages ? <Link href={pageHref(result.page + 1)} className="underline">Next</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
