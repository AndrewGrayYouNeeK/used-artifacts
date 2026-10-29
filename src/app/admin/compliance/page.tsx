import { Suspense } from "react";
import Link from "next/link";
import { feeRates } from "@/config/economics";
import { UserIdentity } from "@/components/user-identity";
import { getPublicIdentities } from "@/domains/identity/public-identity";
import { formatUsd, priceBreakdown } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { photoUrl } from "@/lib/storage/storage";
import { AiAnalysisSummary } from "@/components/ai-analysis-summary";
import { DecisionForm } from "./decision-form";

export default function CompliancePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Queue />
      </Suspense>
    </div>
  );
}

interface ScreeningFlag {
  field: string;
  matchedText: string;
  reason: string;
}

interface ReusedPhotoFlag {
  listingId: string;
  distance: number;
  linkedSeller: boolean;
  sellerUserId: string;
}

function reusedPhotoFlags(flags: unknown): ReusedPhotoFlag[] {
  if (!flags || typeof flags !== "object" || !("reusedPhotos" in flags)) return [];
  const list = (flags as { reusedPhotos: unknown }).reusedPhotos;
  return Array.isArray(list) ? (list as ReusedPhotoFlag[]) : [];
}

function screeningFlags(flags: unknown): ScreeningFlag[] {
  if (!flags || typeof flags !== "object" || !("screening" in flags)) return [];
  const list = (flags as { screening: unknown }).screening;
  return Array.isArray(list) ? (list as ScreeningFlag[]) : [];
}

async function Queue() {
  const staff = await requireStaff();
  const [reviews, identityReviews, fraudSignals, recent] = await Promise.all([
    db.complianceReview.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      include: {
        listing: {
          include: {
            category: { include: { parent: { select: { name: true } } } },
            provenanceStatements: { orderBy: { signedAt: "desc" }, take: 1, include: { template: true } },
            photos: { orderBy: { sortOrder: "asc" } },
            aiAnalyses: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
    }),
    db.identityVerification.findMany({
      where: { status: "NEEDS_REVIEW" },
      orderBy: { updatedAt: "asc" },
      include: { user: { select: { email: true, displayName: true, createdAt: true } } },
    }),
    db.fraudSignal.findMany({
      where: { status: "OPEN", detector: "DUPLICATE_IDENTITY" },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.complianceReview.findMany({
      where: { status: { not: "OPEN" } },
      orderBy: { decidedAt: "desc" },
      take: 10,
      include: {
        listing: { select: { id: true, title: true } },
        reviewer: { select: { displayName: true } },
      },
    }),
  ]);

  const userIds = [
    ...reviews.map((r) => r.listing.sellerUserId),
    ...identityReviews.flatMap((v) => (v.conflictingUserId ? [v.conflictingUserId] : [])),
  ];
  const [identities, conflictingUsers] = await Promise.all([
    getPublicIdentities(db, userIds),
    db.user.findMany({
      where: { id: { in: identityReviews.flatMap((v) => (v.conflictingUserId ? [v.conflictingUserId] : [])) } },
      select: { id: true, email: true, displayName: true },
    }),
  ]);
  const rates = feeRates();

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-2xl font-semibold">Compliance queue</h1>
        <Link href="/admin" className="text-sm underline">
          Back to GM dashboard
        </Link>
      </div>

      <section className="space-y-4">
        <h2 className="font-serif text-lg font-semibold">Listings awaiting review ({reviews.length})</h2>
        {reviews.length === 0 && <p className="text-sm text-stone-500">Nothing waiting.</p>}
        {reviews.map((r) => {
          const l = r.listing;
          const st = l.provenanceStatements[0];
          const prices = l.askingPriceCents === null ? null : priceBreakdown(l.askingPriceCents, rates);
          const seller = identities.get(l.sellerUserId);
          const flags = screeningFlags(r.flags);
          const reused = reusedPhotoFlags(r.flags);
          const analysis = l.aiAnalyses[0];
          return (
            <article key={r.id} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-stone-500">
                    {l.category.parent?.name} › {l.category.name}
                    {l.category.isNativeAmerican && " · Native American"}
                  </p>
                  <Link href={`/listings/${l.id}`} className="mt-1 block font-serif text-lg font-semibold underline">
                    {l.title}
                  </Link>
                  <div className="mt-1 text-sm">{seller && <UserIdentity identity={seller} />}</div>
                </div>
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium">
                  {r.reason.replaceAll("_", " ").toLowerCase()}
                </span>
              </div>
              {flags.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                  {flags.map((f, i) => (
                    <li key={i}>
                      <strong>{f.reason}</strong>: “{f.matchedText}” in {f.field}
                    </li>
                  ))}
                </ul>
              )}
              {l.photos.length > 0 && (
                <div className="mt-3 flex gap-2 overflow-x-auto">
                  {l.photos.map((p) => (
                    <a key={p.id} href={photoUrl(p.storageKey)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(p.storageKey)} alt="" className="h-24 w-24 rounded-lg object-cover ring-1 ring-stone-200" />
                    </a>
                  ))}
                </div>
              )}
              {reused.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                  {reused.map((m) => (
                    <li key={m.listingId}>
                      <strong>Photo seen before</strong> on{" "}
                      <Link href={`/listings/${m.listingId}`} className="underline">
                        another listing
                      </Link>{" "}
                      ({m.distance === 0 ? "identical" : `${m.distance}-bit difference`}
                      {m.sellerUserId === l.sellerUserId ? ", same seller" : m.linkedSeller ? ", linked account" : ", different seller"})
                    </li>
                  ))}
                </ul>
              )}
              {analysis && (
                <div className="mt-3">
                  <AiAnalysisSummary analysis={analysis} />
                </div>
              )}
              <p className="mt-3 whitespace-pre-line text-sm text-stone-700">{l.description}</p>
              {prices && (
                <p className="mt-2 text-xs text-stone-500">
                  Asking {formatUsd(prices.askingCents)} · buyer price {formatUsd(prices.buyerPriceCents)} · payout{" "}
                  {formatUsd(prices.sellerPayoutCents)}
                </p>
              )}
              {st && (
                <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-y-1 rounded-lg bg-stone-50 p-3 text-xs">
                  <dt className="text-stone-500">Acquisition</dt>
                  <dd>
                    {st.acquisitionSource.replaceAll("_", " ").toLowerCase()}
                    {st.acquisitionState ? `, ${st.acquisitionState}` : ""}
                    {st.acquisitionYearApprox ? `, ~${st.acquisitionYearApprox}` : ""}
                  </dd>
                  {st.landownerName && (
                    <>
                      <dt className="text-stone-500">Landowner</dt>
                      <dd>{st.landownerName}</dd>
                    </>
                  )}
                  <dt className="text-stone-500">Details</dt>
                  <dd className="whitespace-pre-line">{st.acquisitionDetails}</dd>
                  <dt className="text-stone-500">Signed</dt>
                  <dd>
                    {st.signedName}, {st.signedAt.toISOString().replace("T", " ").slice(0, 16)} · template v
                    {st.template.version}
                    {st.template.isDraft ? " (draft)" : ""} · {st.signatureHash.slice(0, 12)}…
                  </dd>
                  {l.category.isNativeAmerican && (
                    <>
                      <dt className="text-stone-500">IACA acknowledged</dt>
                      <dd>{st.iacaDisclosureAcknowledged ? "yes" : "no"}</dd>
                    </>
                  )}
                </dl>
              )}
              <div className="mt-4">
                {l.sellerUserId === staff.id ? (
                  <p className="text-xs text-stone-500">Your own listing: another staff member must review it.</p>
                ) : (
                  <DecisionForm kind="listing" id={r.id} />
                )}
              </div>
            </article>
          );
        })}
      </section>

      {recent.length > 0 && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Recently decided</h2>
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <Link href={`/listings/${r.listing.id}`} className="underline">
                  {r.listing.title}
                </Link>
                <span className={r.status === "APPROVED" ? "text-emerald-700" : "text-red-700"}>
                  {r.status.toLowerCase()} by {r.reviewer?.displayName ?? "unknown"}
                  {r.decidedAt ? ` · ${r.decidedAt.toISOString().replace("T", " ").slice(0, 16)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="font-serif text-lg font-semibold">Identity reviews ({identityReviews.length})</h2>
        <p className="text-sm text-stone-500">
          Same legal name and date of birth as another account, but a different document. Possibly
          one person with two accounts.
        </p>
        {identityReviews.map((v) => {
          const other = conflictingUsers.find((u) => u.id === v.conflictingUserId);
          return (
            <article key={v.id} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
              <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
                <dt className="text-stone-500">Account</dt>
                <dd>
                  {v.user.displayName} ({v.user.email})
                </dd>
                <dt className="text-stone-500">Legal name</dt>
                <dd>
                  {v.legalName}, born {v.dobYear}
                </dd>
                <dt className="text-stone-500">Document</dt>
                <dd>
                  {v.documentType} · {v.issuingCountry}
                </dd>
                <dt className="text-stone-500">Matches account</dt>
                <dd>{other ? `${other.displayName} (${other.email})` : v.conflictingUserId}</dd>
              </dl>
              <div className="mt-4">
                <DecisionForm kind="identity" id={v.id} />
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Duplicate-identity signals</h2>
        {fraudSignals.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">None open.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 font-mono text-xs">
            {fraudSignals.map((f) => (
              <li key={f.id} className="py-1.5">
                {f.createdAt.toISOString().slice(0, 16)} · user {f.subjectId.slice(0, 10)} · score {f.score} ·{" "}
                {JSON.stringify(f.evidence)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
