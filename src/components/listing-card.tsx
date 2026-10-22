import Link from "next/link";
import { feeRates } from "@/config/economics";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
import { photoUrl } from "@/lib/storage/storage";

export interface ListingCardData {
  id: string;
  title: string;
  askingPriceCents: number | null;
  photos: { storageKey: string }[];
  storefront?: { name: string };
  /** The live auction, for AUCTION listings (amounts are already buyer prices). */
  auctions?: { currentPriceCents: number | null; startingBidCents: number }[];
}

/** Public card: shows only the buyer price (asking + buyer fee). */
export function ListingCard({ listing }: { listing: ListingCardData }) {
  const photo = listing.photos[0];
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group block overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm hover:border-stone-400"
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(photo.storageKey)} alt={listing.title} className="aspect-square w-full bg-stone-100 object-cover" />
      ) : (
        <div className="aspect-square w-full bg-stone-100" />
      )}
      <div className="p-4">
        <p className="line-clamp-2 font-medium group-hover:underline">{listing.title}</p>
        {listing.askingPriceCents !== null && (
          <p className="mt-1 font-semibold">{formatUsd(priceBreakdown(listing.askingPriceCents, feeRates()).buyerPriceCents)}</p>
        )}
        {listing.auctions?.[0] && (
          <p className="mt-1 font-semibold">
            {formatUsd(listing.auctions[0].currentPriceCents ?? listing.auctions[0].startingBidCents)}
            <span className="ml-1 text-xs font-normal text-stone-500">
              {listing.auctions[0].currentPriceCents === null ? "starting bid" : "current bid"}
            </span>
          </p>
        )}
        {listing.storefront && <p className="mt-1 text-xs text-stone-500">{listing.storefront.name}</p>}
      </div>
    </Link>
  );
}
