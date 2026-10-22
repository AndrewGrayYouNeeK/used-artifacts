import { Suspense } from "react";
import { connection } from "next/server";
import { platform } from "@/config/platform";
import { db } from "@/lib/db";

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <section className="max-w-2xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">
          Closed beta
        </p>
        <h1 className="font-serif text-5xl font-semibold leading-tight tracking-tight">
          Artifacts with a paper trail.
        </h1>
        <p className="mt-5 text-lg text-stone-600">
          Every seller is ID-verified and signs a provenance statement for every piece. Payment is
          held until you confirm delivery. High-value pieces are checked by independent
          authenticators.
        </p>
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
    select: { id: true, name: true, isNativeAmerican: true, children: { select: { id: true } } },
  });
  if (categories.length === 0) {
    return <p className="text-sm text-stone-500">No categories yet. Run the database seed.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {categories.map((c) => (
        <li key={c.id} className="rounded-xl border border-stone-200 bg-white px-4 py-4 shadow-sm">
          <span className="font-medium">{c.name}</span>
          <span className="mt-1 block text-xs text-stone-500">
            {c.children.length} subcategories
            {c.isNativeAmerican && " · enhanced review"}
          </span>
        </li>
      ))}
    </ul>
  );
}
