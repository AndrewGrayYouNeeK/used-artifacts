import { Suspense } from "react";
import Link from "next/link";
import { feeRates } from "@/config/economics";
import type { ListingStatus } from "@/generated/prisma/enums";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { StorefrontForm } from "./storefront-form";

export default function SellPage({ searchParams }: PageProps<"/sell">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-stone-100" />}>
        <SellDashboard searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const statusLabel: Record<ListingStatus, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "In compliance review",
  REJECTED: "Not approved",
  LIVE: "Live",
  SOLD: "Sold",
  ENDED: "Ended",
  REMOVED: "Removed",
};

async function SellDashboard({ searchParams }: { searchParams: PageProps<"/sell">["searchParams"] }) {
  const user = await requireUser();
  const { submitted } = await searchParams;
  const gate = await checkIdentityGate(db, user.id, "SELL");
  if (!gate.ok) {
    return (
      <section className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-2xl font-semibold">Sell on Used Artifacts</h1>
        <p className="mt-2 text-sm text-stone-600">
          Every seller verifies their identity first, and each person may have only one account.
        </p>
        <Link
          href="/account"
          className="mt-4 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          Check my verification status
        </Link>
      </section>
    );
  }

  const storefront = await db.storefront.findFirst({ where: { ownerUserId: user.id } });
  if (!storefront) {
    return (
      <section className="mx-auto max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-2xl font-semibold">Open your storefront</h1>
        <p className="mt-2 text-sm text-stone-600">Your storefront is your shop page under the Used Artifacts brand.</p>
        <div className="mt-6">
          <StorefrontForm />
        </div>
      </section>
    );
  }

  const listings = await db.listing.findMany({
    where: { sellerUserId: user.id },
    orderBy: { createdAt: "desc" },
    include: { complianceReviews: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const rates = feeRates();

  return (
    <>
      {typeof submitted === "string" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Listing submitted with your signed provenance statement. During the beta every listing is
          reviewed before it goes live.
        </p>
      )}
      <section className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Your storefront</p>
          <h1 className="mt-1 font-serif text-2xl font-semibold">{storefront.name}</h1>
          <Link href={`/s/${storefront.slug}`} className="text-sm text-stone-600 underline">
            usedartifacts.com/s/{storefront.slug}
          </Link>
        </div>
        <Link
          href="/sell/new"
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          New listing
        </Link>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Your listings</h2>
        {listings.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No listings yet.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-2 pr-4">Title</th>
                <th className="py-2 pr-4">Your asking price</th>
                <th className="py-2 pr-4">Buyers see</th>
                <th className="py-2 pr-4">You receive</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {listings.map((l) => {
                const p = l.askingPriceCents === null ? null : priceBreakdown(l.askingPriceCents, rates);
                const review = l.complianceReviews[0];
                return (
                  <tr key={l.id} className="align-top">
                    <td className="py-2 pr-4">
                      <Link href={`/listings/${l.id}`} className="underline">
                        {l.title}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{p ? formatUsd(p.askingCents) : "-"}</td>
                    <td className="py-2 pr-4">{p ? formatUsd(p.buyerPriceCents) : "-"}</td>
                    <td className="py-2 pr-4">{p ? formatUsd(p.sellerPayoutCents) : "-"}</td>
                    <td className="py-2">
                      {statusLabel[l.status]}
                      {l.status === "REJECTED" && review?.notes && (
                        <span className="mt-1 block text-xs text-red-700">{review.notes}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
