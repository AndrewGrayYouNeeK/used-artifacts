import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { UserIdentity } from "@/components/user-identity";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { ListingCard } from "@/components/listing-card";
import { db } from "@/lib/db";

export default function StorefrontPage({ params }: PageProps<"/s/[slug]">) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Storefront params={params} />
      </Suspense>
    </div>
  );
}

async function Storefront({ params }: { params: PageProps<"/s/[slug]">["params"] }) {
  await connection();
  const { slug } = await params;
  const store = await db.storefront.findUnique({
    where: { slug },
    include: {
      listings: {
        where: { status: "LIVE" },
        orderBy: { publishedAt: "desc" },
        include: { photos: { orderBy: { sortOrder: "asc" }, take: 1 }, gradingSubmissions: { where: { results: { some: { status: "PUBLISHED", tierAwarded: "AUTHENTICATED" } } }, select: { id: true }, take: 1 } },
      },
    },
  });
  if (!store || store.status !== "ACTIVE") notFound();
  const owner = await getPublicIdentity(db, store.ownerUserId);

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-3xl font-semibold">{store.name}</h1>
        <div className="mt-3">{owner && <UserIdentity identity={owner} />}</div>
      </header>
      {store.listings.length === 0 ? (
        <p className="text-sm text-stone-500">No live listings yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {store.listings.map((l) => (
            <li key={l.id}>
              <ListingCard listing={l} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
