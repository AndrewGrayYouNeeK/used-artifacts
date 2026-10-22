import { Suspense } from "react";
import Link from "next/link";
import { feeRates } from "@/config/economics";
import type { AuctionStatus, GradingSubmissionStatus, ListingStatus } from "@/generated/prisma/enums";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import {
  cancelOrderAction,
  markShippedAction,
  startPayoutOnboardingAction,
} from "@/app/actions/orders";
import { changePriceAction, withdrawListingAction } from "@/app/actions/listings";
import { requestAuthenticationAction } from "@/app/actions/grading";
import { authenticationEligibility } from "@/domains/grading/authentication";
import { sellerAuctionDecisionAction } from "@/app/actions/auctions";
import { ActionForm, inputClass } from "@/components/action-form";
import { UncertaintyBadge } from "@/components/uncertainty-badge";
import { OrderStatusBadge } from "@/components/order-status";
import { CARRIERS } from "@/domains/orders/fulfillment";
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

const auctionLabel: Record<AuctionStatus, string> = {
  SCHEDULED: "starts when approved",
  LIVE: "bidding open",
  ENDED: "won, awaiting payment",
  SETTLED: "paid",
  UNSOLD: "ended unsold",
  AWAITING_SELLER: "winner didn't pay: your decision",
  RELISTED: "relisted",
  CANCELLED: "cancelled",
};

async function SellDashboard({ searchParams }: { searchParams: PageProps<"/sell">["searchParams"] }) {
  const user = await requireUser();
  const { submitted, payouts } = await searchParams;
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
    include: {
      complianceReviews: { orderBy: { createdAt: "desc" }, take: 1 },
      aiAnalyses: { orderBy: { createdAt: "desc" }, take: 1, select: { uncertainty: true, blocksPublishing: true } },
      auctions: { orderBy: { createdAt: "desc" }, take: 1 },
      category: { select: { vertical: true } },
      gradingSubmissions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, results: { where: { status: "PUBLISHED" }, select: { certificateNumber: true }, take: 1 } },
      },
    },
  });
  const rates = feeRates();
  const sales = await db.order.findMany({
    where: { sellerUserId: user.id, status: { notIn: ["CREATED", "EXPIRED"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { listing: { select: { title: true } }, shipment: true },
  });

  return (
    <>
      {typeof submitted === "string" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Listing submitted with your signed provenance statement. During the beta every listing is
          reviewed before it goes live.
        </p>
      )}
      {payouts === "1" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Payouts are on. Buyers can now purchase your live listings.
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

      {!storefront.payoutsEnabled && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="font-serif text-lg font-semibold text-amber-950">Set up payouts</h2>
          <p className="mt-1 text-sm text-amber-900">
            Buyers can&apos;t purchase until payouts are on. Stripe collects your bank and tax details;
            we never see your bank account number.
          </p>
          <div className="mt-4">
            <ActionForm
              action={startPayoutOnboardingAction}
              submitLabel={storefront.stripeAccountId ? "Continue payout setup" : "Set up payouts with Stripe"}
            />
          </div>
        </section>
      )}

      {sales.length > 0 && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Sales</h2>
          <ul className="mt-4 divide-y divide-stone-100">
            {sales.map((o) => (
              <li key={o.id} className="grid gap-3 py-4 md:grid-cols-[1fr_auto]">
                <div className="text-sm">
                  <p className="font-medium">{o.listing.title}</p>
                  <p className="text-stone-600">
                    You receive {formatUsd(o.sellerPayoutCents + o.shippingCents)} ({formatUsd(o.sellerPayoutCents)} +{" "}
                    {formatUsd(o.shippingCents)} shipping) when the buyer confirms delivery.
                  </p>
                  {o.status === "PAID_HELD" && isShippingAddress(o.shippingAddress) && (
                    <address className="mt-2 not-italic text-stone-700">
                      Ship to: {o.shippingAddress.name}, {o.shippingAddress.line1}, {o.shippingAddress.city},{" "}
                      {o.shippingAddress.state} {o.shippingAddress.postalCode}
                    </address>
                  )}
                  {o.shipment && (
                    <p className="mt-1 text-stone-500">
                      {o.shipment.carrier} {o.shipment.trackingNumber}
                    </p>
                  )}
                  {o.status === "PAID_HELD" && (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <ActionForm action={markShippedAction} submitLabel="Mark shipped">
                        <input type="hidden" name="orderId" value={o.id} />
                        <div className="grid grid-cols-[6rem_1fr] gap-2">
                          <select name="carrier" className={inputClass} defaultValue="USPS">
                            {CARRIERS.map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                          <input name="trackingNumber" required placeholder="Tracking number" className={inputClass} />
                        </div>
                      </ActionForm>
                      <ActionForm
                        action={cancelOrderAction}
                        submitLabel="Can't ship: cancel and refund"
                        variant="danger"
                        confirm="Cancel this order and refund the buyer in full?"
                      >
                        <input type="hidden" name="orderId" value={o.id} />
                        <input name="reason" placeholder="Reason (shown to the buyer)" className={inputClass} />
                      </ActionForm>
                    </div>
                  )}
                </div>
                <div>
                  <OrderStatusBadge status={o.status} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {listings.map((l) => {
                const p = l.askingPriceCents === null ? null : priceBreakdown(l.askingPriceCents, rates);
                const review = l.complianceReviews[0];
                const auction = l.format === "AUCTION" ? l.auctions[0] : undefined;
                return (
                  <tr key={l.id} className="align-top">
                    <td className="py-2 pr-4">
                      <Link href={`/listings/${l.id}`} className="underline">
                        {l.title}
                      </Link>
                    </td>
                    {auction ? (
                      <td className="py-2 pr-4" colSpan={3}>
                        Auction · {auction.bidCount} bid{auction.bidCount === 1 ? "" : "s"} ·{" "}
                        {formatUsd(auction.currentPriceCents ?? auction.startingBidCents)}
                        {auction.currentPriceCents === null ? " start" : " current"}
                        {auction.reserveCents !== null && ` · reserve ${auction.reserveMet ? "met" : "not met"}`}
                        {auction.endsAt && auction.status === "LIVE" && (
                          <span className="block text-xs text-stone-500">Ends {auction.endsAt.toISOString().replace("T", " ").slice(0, 16)} UTC</span>
                        )}
                      </td>
                    ) : (
                      <>
                        <td className="py-2 pr-4">{p ? formatUsd(p.askingCents) : "-"}</td>
                        <td className="py-2 pr-4">{p ? formatUsd(p.buyerPriceCents) : "-"}</td>
                        <td className="py-2 pr-4">{p ? formatUsd(p.sellerPayoutCents) : "-"}</td>
                      </>
                    )}
                    <td className="py-2">
                      {statusLabel[l.status]}
                      {auction && <span className="mt-1 block text-xs text-stone-600">Auction {auctionLabel[auction.status]}</span>}
                      {auction?.status === "AWAITING_SELLER" && (
                        <div className="mt-2 space-y-2">
                          <ActionForm action={sellerAuctionDecisionAction} submitLabel="Offer to next bidder" variant="secondary">
                            <input type="hidden" name="auctionId" value={auction.id} />
                            <input type="hidden" name="decision" value="SECOND_CHANCE" />
                          </ActionForm>
                          <ActionForm action={sellerAuctionDecisionAction} submitLabel="Relist" variant="secondary">
                            <input type="hidden" name="auctionId" value={auction.id} />
                            <input type="hidden" name="decision" value="RELIST" />
                          </ActionForm>
                          {auction.sellerDecisionDueAt && (
                            <span className="block text-xs text-stone-500">
                              Relists automatically on {auction.sellerDecisionDueAt.toISOString().slice(0, 10)}
                            </span>
                          )}
                        </div>
                      )}
                      <AuthenticationStatus listing={l} />
                      {l.status === "REJECTED" && review?.notes && (
                        <span className="mt-1 block text-xs text-red-700">{review.notes}</span>
                      )}
                      {l.status === "PENDING_REVIEW" && l.aiAnalyses[0] && (
                        <span className="mt-1 flex items-center gap-1 text-xs text-stone-600">
                          AI check: <UncertaintyBadge uncertainty={l.aiAnalyses[0].uncertainty} />
                          {l.aiAnalyses[0].blocksPublishing && <span className="text-red-700">extra compliance review</span>}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {(l.status === "LIVE" || l.status === "PENDING_REVIEW") && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-stone-600">Edit</summary>
                          <div className="mt-2 space-y-3">
                            {l.format === "FIXED" && (
                              <ActionForm action={changePriceAction} submitLabel="Change price" variant="secondary">
                                <input type="hidden" name="listingId" value={l.id} />
                                <input
                                  name="askingPrice"
                                  required
                                  inputMode="decimal"
                                  defaultValue={p ? (p.askingCents / 100).toFixed(2) : ""}
                                  className={inputClass}
                                />
                              </ActionForm>
                            )}
                            <ActionForm
                              action={withdrawListingAction}
                              submitLabel="Withdraw listing"
                              variant="danger"
                              confirm="Take this listing down?"
                            >
                              <input type="hidden" name="listingId" value={l.id} />
                            </ActionForm>
                          </div>
                        </details>
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

const OPEN_SUBMISSION: readonly GradingSubmissionStatus[] = ["SUBMITTED", "RECEIVED", "IN_REVIEW"];

const submissionLabel: Record<GradingSubmissionStatus, string> = {
  SUBMITTED: "requested",
  RECEIVED: "item received",
  IN_REVIEW: "with a partner",
  COMPLETED: "authenticated",
  REJECTED: "not authenticated",
  RETURNED: "inconclusive",
};

type SellerListing = Parameters<typeof authenticationEligibility>[0] & {
  id: string;
  gradingSubmissions: { status: GradingSubmissionStatus; results: { certificateNumber: string }[] }[];
};

/** Partner authentication state for one listing, or the request form when it's eligible. */
function AuthenticationStatus({ listing }: { listing: SellerListing }) {
  const submission = listing.gradingSubmissions[0];
  const cert = submission?.results[0]?.certificateNumber;
  if (cert) return <span className="mt-1 block text-xs text-emerald-800">Authenticated by partner · {cert}</span>;
  if (submission && OPEN_SUBMISSION.includes(submission.status)) {
    return <span className="mt-1 block text-xs text-stone-600">Authentication {submissionLabel[submission.status]}</span>;
  }
  if (authenticationEligibility(listing)) return null;
  return (
    <>
      {submission && <span className="mt-1 block text-xs text-stone-600">Last authentication: {submissionLabel[submission.status]}</span>}
      <ActionForm action={requestAuthenticationAction} submitLabel="Request partner authentication" variant="secondary" className="mt-2 space-y-1">
        <input type="hidden" name="listingId" value={listing.id} />
        <input name="notes" placeholder="Anything the partner should know (optional)" className={inputClass} />
        <span className="block text-xs text-stone-500">Free during the beta. A partner reviews your photos and description.</span>
      </ActionForm>
    </>
  );
}

function isShippingAddress(
  v: unknown,
): v is { name: string; line1: string; city: string; state: string; postalCode: string } {
  return typeof v === "object" && v !== null && "line1" in v && "postalCode" in v;
}
