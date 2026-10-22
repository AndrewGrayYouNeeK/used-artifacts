import { Suspense } from "react";
import { redirect } from "next/navigation";
import { feeRates } from "@/config/economics";
import { platform } from "@/config/platform";
import { IACA_DISCLOSURE } from "@/domains/compliance/provenance-template";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import { currentProvenanceTemplate } from "@/domains/listings/listings";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { ListingForm } from "./listing-form";

export default function NewListingPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-stone-100" />}>
        <NewListing />
      </Suspense>
    </div>
  );
}

async function NewListing() {
  const user = await requireUser();
  const gate = await checkIdentityGate(db, user.id, "SELL");
  if (!gate.ok) redirect("/sell");
  const storefront = await db.storefront.findFirst({ where: { ownerUserId: user.id, status: "ACTIVE" } });
  if (!storefront) redirect("/sell");

  const [categories, template] = await Promise.all([
    db.category.findMany({
      where: { parentId: { not: null }, vertical: { in: platform.enabledVerticals } },
      include: { parent: { select: { name: true, sortOrder: true } } },
    }),
    currentProvenanceTemplate(db),
  ]);
  categories.sort(
    (a, b) => (a.parent?.sortOrder ?? 0) - (b.parent?.sortOrder ?? 0) || a.sortOrder - b.sortOrder,
  );

  return (
    <ListingForm
      rates={feeRates()}
      legalName={gate.legalName}
      iacaDisclosure={IACA_DISCLOSURE}
      template={{
        version: template.version,
        isDraft: template.isDraft,
        body: template.body,
        attestations: template.attestations,
      }}
      categories={categories.map((c) => ({
        id: c.id,
        label: `${c.parent?.name ?? ""} › ${c.name}`,
        isNativeAmerican: c.isNativeAmerican,
        requiresEnhancedReview: c.requiresEnhancedReview,
      }))}
    />
  );
}
