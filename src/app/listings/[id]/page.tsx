import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after, connection } from "next/server";
import { economics, feeRates } from "@/config/economics";
import { UserIdentity } from "@/components/user-identity";
import { IACA_DISCLOSURE } from "@/domains/compliance/provenance-template";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
import { ActionForm } from "@/components/action-form";
import { buyNowAction } from "@/app/actions/orders";
import { recordListingView } from "@/domains/listings/manage";
import { getCurrentUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { photoUrl } from "@/lib/storage/storage";

export default function ListingPage({ params }: PageProps<"/listings/[id]">) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-stone-100" />}>
        <Listing params={params} />
      </Suspense>
    </div>
  );
}

const SOURCE_LABEL = {
  PURCHASED: "Purchased",
  INHERITED: "Inherited or gifted",
  PRIVATE_LAND_WITH_PERMISSION: "Found on private land with permission",
  OTHER: "Other",
} as const;

async function Listing({ params }: { params: PageProps<"/listings/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const [listing, viewer] = await Promise.all([
    db.listing.findUnique({
      where: { id },
      include: {
        category: { include: { parent: true } },
        storefront: { select: { name: true, slug: true, payoutsEnabled: true } },
        photos: { orderBy: { sortOrder: "asc" } },
        provenanceStatements: {
          orderBy: { signedAt: "desc" },
          take: 1,
          include: { template: { select: { version: true, isDraft: true } } },
        },
      },
    }),
    getCurrentUser(),
  ]);
  if (!listing) notFound();
  const isSeller = viewer?.id === listing.sellerUserId;
  const isStaff = viewer?.role === "OWNER" || viewer?.role === "MODERATOR";
  if (listing.status !== "LIVE" && listing.status !== "SOLD" && !isSeller && !isStaff) notFound();

  if (listing.status === "LIVE" && !isSeller) after(() => recordListingView(db, listing.id));
  const seller = await getPublicIdentity(db, listing.sellerUserId);
  const prices = listing.askingPriceCents === null ? null : priceBreakdown(listing.askingPriceCents, feeRates());
  const statement = listing.provenanceStatements[0];

  return (
    <article className="space-y-6">
      {listing.status !== "LIVE" && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Only you and staff can see this listing. Status: {listing.status.replace("_", " ").toLowerCase()}.
        </p>
      )}
      {listing.photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {listing.photos.map((photo, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={photo.id}
              src={photoUrl(photo.storageKey)}
              alt={`${listing.title}, photo ${i + 1}`}
              width={photo.width ?? undefined}
              height={photo.height ?? undefined}
              className={`w-full rounded-xl border border-stone-200 bg-stone-100 object-cover ${i === 0 ? "col-span-2 row-span-2 aspect-square" : "aspect-square"}`}
            />
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-stone-500">
          {listing.category.parent?.name} › {listing.category.name}
        </p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">{listing.title}</h1>
        {prices && <p className="mt-3 text-2xl font-semibold">{formatUsd(prices.buyerPriceCents)}</p>}
        <p className="mt-1 text-xs text-stone-500">
          No fees added at checkout.{" "}
          {listing.shippingCents > 0 ? `US shipping ${formatUsd(listing.shippingCents)}` : "Free US shipping"}; sales
          tax, where it applies, is shown at checkout.
        </p>
        <div className="mt-6 flex items-center gap-3 text-sm">
          {seller && <UserIdentity identity={seller} />}
          <span className="text-stone-400">·</span>
          <Link href={`/s/${listing.storefront.slug}`} className="underline">
            {listing.storefront.name}
          </Link>
        </div>
        <p className="mt-6 whitespace-pre-line text-stone-800">{listing.description}</p>
        <dl className="mt-6 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          {listing.sellerConditionGrade && (
            <>
              <dt className="text-stone-500">Condition (seller)</dt>
              <dd>{listing.sellerConditionGrade}</dd>
            </>
          )}
          {listing.regionOfOrigin && (
            <>
              <dt className="text-stone-500">Region of origin</dt>
              <dd>{listing.regionOfOrigin}</dd>
            </>
          )}
          {listing.estimatedAge && (
            <>
              <dt className="text-stone-500">Estimated age</dt>
              <dd>{listing.estimatedAge}</dd>
            </>
          )}
          {listing.materials && (
            <>
              <dt className="text-stone-500">Materials</dt>
              <dd>{listing.materials}</dd>
            </>
          )}
        </dl>
        <div className="mt-6">
          {listing.status === "SOLD" ? (
            <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">Sold.</p>
          ) : listing.status !== "LIVE" ? null : isSeller ? (
            <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">This is your listing.</p>
          ) : !listing.storefront.payoutsEnabled ? (
            <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">
              The seller is finishing payout setup. Check back soon.
            </p>
          ) : viewer ? (
            <ActionForm action={buyNowAction} submitLabel="Buy now">
              <input type="hidden" name="listingId" value={listing.id} />
              <p className="text-xs text-stone-500">
                Your payment is held until you confirm the item arrived as described (or{" "}
                {economics.escrowAutoReleaseDays} days after carrier-confirmed delivery). Report a problem before then and funds stay on hold.
              </p>
            </ActionForm>
          ) : (
            <Link href="/login" className="inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
              Sign in to buy
            </Link>
          )}
        </div>
      </div>

      {statement && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Provenance</h2>
          <p className="mt-1 text-sm text-stone-600">
            The ID-verified seller signed a sworn provenance statement (v{statement.template.version}
            {statement.template.isDraft ? ", draft wording pending lawyer review" : ""}) on{" "}
            {statement.signedAt.toISOString().slice(0, 10)}, stating the item is not from federal,
            state, or tribal land and is not human remains, a funerary object, a sacred object, or
            cultural patrimony.
          </p>
          <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-stone-500">Acquired</dt>
            <dd>
              {SOURCE_LABEL[statement.acquisitionSource]}
              {statement.acquisitionState ? `, ${statement.acquisitionState}` : ""}
              {statement.acquisitionYearApprox ? `, about ${statement.acquisitionYearApprox}` : ""}
            </dd>
            <dt className="text-stone-500">Seller&apos;s account</dt>
            <dd className="whitespace-pre-line">{statement.acquisitionDetails}</dd>
          </dl>
          {listing.category.isNativeAmerican && (
            <p className="mt-4 text-xs text-stone-500">{IACA_DISCLOSURE}</p>
          )}
        </section>
      )}
    </article>
  );
}
