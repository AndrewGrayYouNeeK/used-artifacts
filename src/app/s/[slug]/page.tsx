import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { feeRates } from "@/config/economics";
import { UserIdentity } from "@/components/user-identity";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
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
    include: { listings: { where: { status: "LIVE" }, orderBy: { publishedAt: "desc" } } },
  });
  if (!store || store.status !== "ACTIVE") notFound();
  const owner = await getPublicIdentity(db, store.ownerUserId);
  const rates = feeRates();

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
            <li key={l.id} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <Link href={`/listings/${l.id}`} className="font-medium underline">
                {l.title}
              </Link>
              {l.askingPriceCents !== null && (
                <p className="mt-2 font-semibold">
                  {formatUsd(priceBreakdown(l.askingPriceCents, rates).buyerPriceCents)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
