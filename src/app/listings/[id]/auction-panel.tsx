import Link from "next/link";
import { payAuctionAction, placeBidAction, retractBidAction } from "@/app/actions/auctions";
import { ActionForm, inputClass } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import type { AuctionView } from "@/domains/auctions/auctions";
import { formatUsd } from "@/domains/pricing/pricing";

const when = (d: Date) => `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;

/** Rendered only while AUCTIONS_ENABLED is on. Bidders never see the reserve or another bidder's maximum. */
export function AuctionPanel({
  auction,
  viewerId,
  isSeller,
  payoutsReady,
}: {
  auction: AuctionView;
  viewerId: string | null;
  isSeller: boolean;
  payoutsReady: boolean;
}) {
  const live = auction.status === "LIVE";
  const price = auction.priceCents ?? auction.startingBidCents;
  return (
    <div className="space-y-4">
      {live && <AutoRefresh seconds={15} />}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-2xl font-semibold">{formatUsd(price)}</p>
        <p className="text-sm text-stone-600">
          {auction.bidCount === 0 ? "Starting bid" : `${auction.bidCount} bid${auction.bidCount === 1 ? "" : "s"}`}
          {" · "}
          {auction.hasReserve ? (auction.reserveMet ? "Reserve met" : "Reserve not met") : "No reserve"}
        </p>
      </div>
      {auction.endsAt && (
        <p className="text-sm text-stone-700">
          {live ? "Ends" : "Ended"} {when(auction.endsAt)}
          {live && <span className="text-stone-500"> · a bid in the last few minutes extends it</span>}
        </p>
      )}

      {live && !isSeller && viewerId && payoutsReady && (
        <ActionForm action={placeBidAction} submitLabel="Place bid">
          <input type="hidden" name="auctionId" value={auction.id} />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-stone-800">
              Your maximum bid (at least {formatUsd(auction.leading && auction.myMaxCents ? auction.myMaxCents + 1 : auction.minimumBidCents)})
            </span>
            <input name="maxBid" required inputMode="decimal" className={inputClass} placeholder={(auction.minimumBidCents / 100).toFixed(2)} />
          </label>
          <p className="text-xs text-stone-500">
            We bid for you, one increment at a time, up to your maximum. The winning bid is the item price: no fees are added at
            checkout. Bidding needs a verified ID. The winner has {auction.paymentWindowHours} hours to pay; unpaid wins are recorded as strikes.
          </p>
          {auction.leading && <p className="text-sm font-medium text-emerald-800">You&apos;re the high bidder (your maximum: {formatUsd(auction.myMaxCents!)}).</p>}
        </ActionForm>
      )}
      {live && !isSeller && !viewerId && (
        <Link href="/login" className="inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
          Sign in to bid
        </Link>
      )}
      {live && !isSeller && viewerId && !payoutsReady && (
        <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">The seller is finishing payout setup. Check back soon.</p>
      )}
      {isSeller && <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">This is your auction.</p>}

      {viewerId && auction.winnerUserId === viewerId && auction.orderId && auction.status === "ENDED" && (
        <ActionForm action={payAuctionAction} submitLabel="Pay now">
          <input type="hidden" name="orderId" value={auction.orderId} />
          <p className="text-sm font-medium text-emerald-800">You won. Pay within the payment window to secure the item.</p>
        </ActionForm>
      )}

      {live && auction.myBids.length > 0 && (
        <details className="rounded-lg border border-stone-200 p-4 text-sm">
          <summary className="cursor-pointer font-medium">Retract a bid</summary>
          <p className="mt-2 text-xs text-stone-500">
            Allowed for an obvious typo (at least 10× the price before it), a materially changed description, or a seller you
            can&apos;t reach. Not in the final 12 hours, except a typo fixed within a minute. One retraction per 90 days.
          </p>
          <ActionForm action={retractBidAction} submitLabel="Request retraction" variant="danger" className="mt-3 space-y-3">
            <select name="bidId" className={inputClass} required>
              {auction.myBids
                .filter((b) => b.retractionStatus === null)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    Max {formatUsd(b.maxCents)} placed {when(b.placedAt)}
                  </option>
                ))}
            </select>
            <select name="kind" className={inputClass} required defaultValue="TYPO">
              <option value="TYPO">Typo</option>
              <option value="DESCRIPTION_CHANGED">The description changed materially</option>
              <option value="SELLER_UNREACHABLE">I can&apos;t reach the seller</option>
            </select>
            <textarea name="reason" required minLength={10} rows={2} className={inputClass} placeholder="What happened?" />
          </ActionForm>
        </details>
      )}

      {auction.history.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">Bid history</h3>
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {auction.history.map((b) => (
              <li key={b.id} className="flex justify-between py-1.5">
                <span>{b.bidder}</span>
                <span className="text-stone-600">
                  {formatUsd(b.priceCents)} · {when(b.placedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
