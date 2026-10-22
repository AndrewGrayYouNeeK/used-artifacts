import { Suspense } from "react";
import { notFound } from "next/navigation";
import { devCompletePaymentAction } from "@/app/actions/orders";
import { ActionForm, inputClass } from "@/components/action-form";
import { AuthCard } from "@/components/form";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { usingFakePayments } from "@/lib/payments/orders-deps";

export default function DevCheckoutPage({ params }: PageProps<"/checkout/dev/[orderId]">) {
  return (
    <AuthCard title="Simulated checkout (dev only)">
      <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-stone-100" />}>
        <DevCheckout params={params} />
      </Suspense>
    </AuthCard>
  );
}

async function DevCheckout({ params }: { params: PageProps<"/checkout/dev/[orderId]">["params"] }) {
  const { orderId } = await params;
  const user = await requireUser();
  if (!usingFakePayments()) notFound();
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { listing: { select: { title: true } }, payments: { where: { status: "REQUIRES_PAYMENT" } } },
  });
  if (!order || order.buyerUserId !== user.id) notFound();
  const payment = order.payments[0];
  if (order.status !== "CREATED" || !payment) {
    return <p className="text-sm text-stone-600">This checkout is closed (order status: {order.status}).</p>;
  }
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
        Stripe isn&apos;t configured, so this page stands in for Stripe Checkout. Reusing a card id or
        address that a linked account used triggers the self-purchase checks.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
        <dt>{order.listing.title}</dt>
        <dd>{formatUsd(order.buyerPriceCents)}</dd>
        <dt>Shipping (US)</dt>
        <dd>{order.shippingCents > 0 ? formatUsd(order.shippingCents) : "Free"}</dd>
        <dt className="font-semibold">Total</dt>
        <dd className="font-semibold">{formatUsd(payment.amountCents)}</dd>
      </dl>
      <ActionForm action={devCompletePaymentAction} submitLabel={`Pay ${formatUsd(payment.amountCents)}`}>
        <input type="hidden" name="orderId" value={order.id} />
        <input name="name" required placeholder="Full name" defaultValue={user.displayName} className={inputClass} />
        <input name="line1" required placeholder="Street address" className={inputClass} />
        <div className="grid grid-cols-[1fr_4rem_6rem] gap-2">
          <input name="city" required placeholder="City" className={inputClass} />
          <input name="state" required placeholder="KY" maxLength={2} className={inputClass} />
          <input name="postalCode" required placeholder="40202" className={inputClass} />
        </div>
        <input name="card" placeholder="Simulated card id (e.g. card_1)" defaultValue="card_test_4242" className={inputClass} />
      </ActionForm>
    </div>
  );
}
