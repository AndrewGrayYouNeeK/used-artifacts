import { Suspense } from "react";
import Link from "next/link";
import {
  addAuthenticatorAction,
  assignAuthenticationAction,
  recordAuthenticationAction,
  revokeAuthenticationAction,
  updateAuthenticatorAction,
} from "@/app/actions/grading";
import { ActionForm, inputClass } from "@/components/action-form";
import { platform } from "@/config/platform";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminGradingPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Grading</h1>
      <p className="text-sm text-stone-600">
        Stage 1: partner authenticators look at high-value pieces (asking {formatUsd(platform.highValueThresholdCents)} or more). Partners
        don&apos;t sign in; you assign the work and record what they found. Authenticated pieces show a badge with a certificate number.
        In-house rubric grading (Stage 2) and antiques come later.
      </p>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Grading />
      </Suspense>
    </div>
  );
}

const OPEN = ["SUBMITTED", "RECEIVED", "IN_REVIEW"] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
const section = "rounded-2xl border border-stone-200 bg-white p-6 shadow-sm";

async function Grading() {
  const staff = await requireStaff();
  const isOwner = staff.role === "OWNER";
  const [partners, categories, waiting, inReview, published, eligible] = await Promise.all([
    db.authenticator.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { results: true } } } }),
    db.category.findMany({ where: { parentId: null, vertical: { in: platform.enabledVerticals } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.gradingSubmission.findMany({
      where: { status: "SUBMITTED" },
      orderBy: { createdAt: "asc" },
      include: { listing: { select: { id: true, title: true, askingPriceCents: true } }, owner: { select: { id: true, displayName: true } } },
    }),
    db.gradingSubmission.findMany({
      where: { status: "IN_REVIEW" },
      orderBy: { updatedAt: "asc" },
      include: { listing: { select: { id: true, title: true } }, assignedAuthenticator: { select: { name: true, organization: true } } },
    }),
    db.gradingResult.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      take: 50,
      include: { submission: { include: { listing: { select: { id: true, title: true } } } }, gradedByAuthenticator: { select: { name: true } } },
    }),
    db.listing.findMany({
      where: {
        status: "LIVE",
        format: "FIXED",
        askingPriceCents: { gte: platform.highValueThresholdCents },
        category: { vertical: { in: platform.enabledVerticals } },
        gradingSubmissions: { none: { OR: [{ status: { in: [...OPEN] } }, { results: { some: { status: "PUBLISHED" } } }] } },
      },
      orderBy: { askingPriceCents: "desc" },
      take: 50,
      select: { id: true, title: true, askingPriceCents: true, seller: { select: { id: true, displayName: true } } },
    }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const active = partners.filter((p) => p.status === "ACTIVE" && p.agreementSignedAt);
  const partnerSelect = (
    <select name="authenticatorId" required className={inputClass} defaultValue="">
      <option value="" disabled>
        Partner…
      </option>
      {active.map((p) => (
        <option key={p.id} value={p.id}>
          {p.organization ? `${p.name} (${p.organization})` : p.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <section className={section}>
        <h2 className="font-serif text-lg font-semibold">Partner authenticators</h2>
        {partners.length === 0 && <p className="mt-2 text-sm text-stone-500">No partners yet.</p>}
        <ul className="mt-3 divide-y divide-stone-100 text-sm">
          {partners.map((p) => (
            <li key={p.id} className="grid gap-2 py-3 md:grid-cols-[1fr_auto]">
              <div>
                <p className="font-medium">
                  {p.name}
                  {p.organization && <span className="text-stone-500"> · {p.organization}</span>}
                </p>
                <p className="text-stone-600">{p.credentials}</p>
                <p className="text-xs text-stone-500">
                  {p.status.toLowerCase()} · {p.agreementSignedAt ? `agreement signed ${day(p.agreementSignedAt)}` : "no signed agreement"} ·{" "}
                  {p.specialtyCategoryIds.length ? p.specialtyCategoryIds.map((id) => categoryName.get(id) ?? "other").join(", ") : "all categories"} ·{" "}
                  {p._count.results} result{p._count.results === 1 ? "" : "s"}
                </p>
              </div>
              {isOwner && p.status !== "TERMINATED" && (
                <ActionForm action={updateAuthenticatorAction} submitLabel="Save" variant="secondary" className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="authenticatorId" value={p.id} />
                  <select name="status" defaultValue={p.status} className={inputClass}>
                    <option value="ACTIVE">Active</option>
                    <option value="PAUSED">Paused</option>
                    <option value="TERMINATED">Ended</option>
                  </select>
                  {!p.agreementSignedAt && (
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="agreementSigned" /> Agreement signed
                    </label>
                  )}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">Add a partner</summary>
            <ActionForm action={addAuthenticatorAction} submitLabel="Add partner" className="mt-3 grid gap-2 sm:grid-cols-2">
              <input name="name" required placeholder="Name" className={inputClass} />
              <input name="organization" placeholder="Organization (shown on badges)" className={inputClass} />
              <input name="credentials" required placeholder="Credentials and experience" className={`${inputClass} sm:col-span-2`} />
              <select name="specialtyCategoryIds" multiple className={`${inputClass} h-28 sm:col-span-2`}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-stone-500 sm:col-span-2">Leave specialties empty for a generalist. Badges name the organization, or the person if none.</p>
              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input type="checkbox" name="agreementSigned" /> Their contractor agreement is signed (needed before assigning work)
              </label>
            </ActionForm>
          </details>
        )}
      </section>

      <section className={section}>
        <h2 className="font-serif text-lg font-semibold">Seller requests</h2>
        {waiting.length === 0 && <p className="mt-2 text-sm text-stone-500">Nothing waiting.</p>}
        <ul className="mt-3 space-y-3 text-sm">
          {waiting.map((s) => (
            <li key={s.id} className="rounded-xl border border-stone-100 p-4">
              <p>
                {s.listing ? (
                  <Link href={`/listings/${s.listing.id}`} className="font-medium underline">
                    {s.listing.title}
                  </Link>
                ) : (
                  "Listing removed"
                )}{" "}
                · asking {s.listing?.askingPriceCents ? formatUsd(s.listing.askingPriceCents) : "-"} ·{" "}
                <Link href={`/admin/users/${s.owner.id}`} className="underline">
                  {s.owner.displayName}
                </Link>{" "}
                · {day(s.createdAt)}
              </p>
              {s.notes && <p className="mt-1 text-stone-600">Seller notes: {s.notes}</p>}
              {isOwner && (
                <ActionForm action={assignAuthenticationAction} submitLabel="Assign" variant="secondary" className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input type="hidden" name="submissionId" value={s.id} />
                  {partnerSelect}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className={section}>
        <h2 className="font-serif text-lg font-semibold">With partners</h2>
        {inReview.length === 0 && <p className="mt-2 text-sm text-stone-500">Nothing out for review.</p>}
        <ul className="mt-3 space-y-3 text-sm">
          {inReview.map((s) => (
            <li key={s.id} className="rounded-xl border border-stone-100 p-4">
              <p>
                {s.listing ? (
                  <Link href={`/listings/${s.listing.id}`} className="font-medium underline">
                    {s.listing.title}
                  </Link>
                ) : (
                  "Listing removed"
                )}{" "}
                · {s.assignedAuthenticator?.organization ?? s.assignedAuthenticator?.name} · since {day(s.updatedAt)}
              </p>
              {isOwner && (
                <ActionForm action={recordAuthenticationAction} submitLabel="Record finding" variant="secondary" className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                  <input type="hidden" name="submissionId" value={s.id} />
                  <select name="outcome" required className={inputClass} defaultValue="">
                    <option value="" disabled>
                      Finding…
                    </option>
                    <option value="AUTHENTICATED">Authenticated</option>
                    <option value="NOT_AUTHENTICATED">Not authenticated</option>
                    <option value="INCONCLUSIVE">Inconclusive</option>
                  </select>
                  <input name="notes" required minLength={5} placeholder="Partner's notes (emailed to the seller unless authenticated)" className={inputClass} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className={section}>
        <h2 className="font-serif text-lg font-semibold">High-value listings not yet authenticated</h2>
        {eligible.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
        <ul className="mt-3 divide-y divide-stone-100 text-sm">
          {eligible.map((l) => (
            <li key={l.id} className="grid gap-2 py-3 md:grid-cols-[1fr_22rem]">
              <p>
                <Link href={`/listings/${l.id}`} className="font-medium underline">
                  {l.title}
                </Link>{" "}
                · asking {formatUsd(l.askingPriceCents ?? 0)} ·{" "}
                <Link href={`/admin/users/${l.seller.id}`} className="underline">
                  {l.seller.displayName}
                </Link>
              </p>
              {isOwner && (
                <ActionForm action={assignAuthenticationAction} submitLabel="Send" variant="secondary" className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input type="hidden" name="listingId" value={l.id} />
                  {partnerSelect}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className={section}>
        <h2 className="font-serif text-lg font-semibold">Published badges</h2>
        {published.length === 0 && <p className="mt-2 text-sm text-stone-500">None yet.</p>}
        <ul className="mt-3 space-y-3 text-sm">
          {published.map((r) => (
            <li key={r.id} className="grid gap-2 md:grid-cols-[1fr_22rem]">
              <p>
                <span className="font-mono">{r.certificateNumber}</span> ·{" "}
                {r.submission.listing ? (
                  <Link href={`/listings/${r.submission.listing.id}`} className="underline">
                    {r.submission.listing.title}
                  </Link>
                ) : (
                  "Listing removed"
                )}{" "}
                · {r.gradedByAuthenticator?.name} · {r.publishedAt && day(r.publishedAt)}
              </p>
              {isOwner && (
                <ActionForm
                  action={revokeAuthenticationAction}
                  submitLabel="Revoke"
                  variant="danger"
                  confirm="Remove this authentication badge?"
                  className="grid gap-2 sm:grid-cols-[1fr_auto]"
                >
                  <input type="hidden" name="resultId" value={r.id} />
                  <input name="reason" required minLength={5} placeholder="Reason (emailed to the seller)" className={inputClass} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
