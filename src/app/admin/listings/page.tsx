import { Suspense } from "react";
import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import type { ListingStatus } from "@/generated/prisma/enums";
import { enforceAction } from "@/app/actions/admin";
import { ActionForm, inputClass } from "@/components/action-form";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminListingsPage({ searchParams }: PageProps<"/admin/listings">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Listings</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <ListingsTable searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const STATUSES: ListingStatus[] = ["LIVE", "PENDING_REVIEW", "SOLD", "ENDED", "REJECTED", "REMOVED", "DRAFT"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function ListingsTable({ searchParams }: { searchParams: PageProps<"/admin/listings">["searchParams"] }) {
  await requireStaff();
  const params = await searchParams;
  const q = one(params.q).trim();
  const status = STATUSES.find((s) => s === one(params.status)) ?? "LIVE";
  const where: Prisma.ListingWhereInput = {
    status,
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { id: q },
            { storefront: { slug: { contains: q.toLowerCase() } } },
          ],
        }
      : {}),
  };
  const listings = await db.listing.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      storefront: { select: { slug: true, name: true } },
      seller: { select: { id: true, displayName: true } },
      category: { select: { name: true } },
    },
  });
  const removable = status === "LIVE" || status === "PENDING_REVIEW";

  return (
    <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input name="q" defaultValue={q} placeholder="Title, storefront or listing ID" className={inputClass} />
        <select name="status" defaultValue={status} className={inputClass}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase().replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
          Filter
        </button>
      </form>
      {status === "PENDING_REVIEW" && (
        <p className="text-sm text-stone-500">
          Approve or reject pending listings in the{" "}
          <Link href="/admin/compliance" className="underline">
            compliance queue
          </Link>
          .
        </p>
      )}
      <ul className="divide-y divide-stone-100">
        {listings.map((l) => (
          <li key={l.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link href={`/listings/${l.id}`} className="font-medium underline-offset-2 hover:underline">
                {l.title}
              </Link>
              <span className="text-stone-500">
                {l.askingPriceCents === null ? "-" : formatUsd(l.askingPriceCents)} · {l.category.name} ·{" "}
                <Link href={`/admin/users/${l.seller.id}`} className="underline">
                  {l.seller.displayName}
                </Link>{" "}
                ({l.storefront.slug}) · {l.createdAt.toISOString().slice(0, 10)}
              </span>
            </div>
            {removable && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-red-800">Remove listing</summary>
                <ActionForm action={enforceAction} submitLabel="Remove" variant="danger" className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input type="hidden" name="type" value="LISTING_REMOVED" />
                  <input type="hidden" name="userId" value={l.seller.id} />
                  <input type="hidden" name="listingId" value={l.id} />
                  <input name="reason" required minLength={5} placeholder="Reason (emailed to the seller)" className={inputClass} />
                </ActionForm>
              </details>
            )}
          </li>
        ))}
      </ul>
      {listings.length === 0 && <p className="py-6 text-center text-sm text-stone-500">No listings.</p>}
    </section>
  );
}
