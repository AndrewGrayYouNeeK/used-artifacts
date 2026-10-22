import { Prisma, type Order } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { isVerticalEnabled } from "@/config/platform";
import { feeRates } from "@/config/economics";
import { priceBreakdown } from "@/domains/pricing/pricing";
import { checkSelfDealing, linkByDevice, raiseFraudSignal } from "@/domains/trust/linkage";
import { clock, econ, platformConfig, type OrdersDeps } from "./deps";
import { transition } from "./escrow";

export type StartCheckoutResult =
  | { ok: true; orderId: string; url: string }
  | {
      ok: false;
      reason: "LISTING_UNAVAILABLE" | "SELLER_NOT_READY" | "LISTING_RESERVED" | "OWN_LISTING" | "SELF_DEALING";
    };

/**
 * Creates an order with the fee snapshot and opens a hosted checkout. The
 * buyer pays the shown buyer price plus the seller's shipping (and tax when
 * enabled), never a platform fee on top. ID verification is not required to
 * buy at a fixed price (owner decision B4).
 */
export async function startCheckout(
  deps: OrdersDeps,
  input: { buyerUserId: string; buyerEmail: string; listingId: string },
  ctx: RequestContext = {},
): Promise<StartCheckoutResult> {
  const now = clock(deps);
  const config = econ(deps);
  const listing = await deps.db.listing.findUnique({
    where: { id: input.listingId },
    include: { storefront: true, category: { select: { vertical: true } } },
  });
  if (
    !listing ||
    listing.status !== "LIVE" ||
    listing.format !== "FIXED" ||
    listing.askingPriceCents === null ||
    !isVerticalEnabled(listing.category.vertical, platformConfig(deps))
  ) {
    return { ok: false, reason: "LISTING_UNAVAILABLE" };
  }
  const { storefront } = listing;
  if (storefront.status !== "ACTIVE" || !storefront.payoutsEnabled || !storefront.stripeAccountId) {
    return { ok: false, reason: "SELLER_NOT_READY" };
  }

  if (ctx.deviceIdHash) {
    const device = ctx.deviceIdHash;
    await deps.db.$transaction((tx) => linkByDevice(tx, input.buyerUserId, device));
  }
  const selfDeal = await checkSelfDealing(deps.db, {
    buyerUserId: input.buyerUserId,
    sellerUserId: listing.sellerUserId,
    storefrontId: storefront.id,
  });
  if (!selfDeal.ok) {
    switch (selfDeal.reason) {
      case "OWN_LISTING":
      case "STOREFRONT_MEMBER":
        return { ok: false, reason: "OWN_LISTING" };
      case "LINKED_ACCOUNT":
        await deps.db.$transaction(async (tx) => {
          await raiseFraudSignal(tx, {
            detector: "SELF_BUY",
            subjectType: "User",
            subjectId: input.buyerUserId,
            score: 80,
            evidence: { listingId: listing.id, sellerUserId: listing.sellerUserId, signals: selfDeal.signals },
          });
          await writeAuditEvent(tx, {
            actorUserId: input.buyerUserId,
            actorType: "USER",
            action: "order.self_buy_blocked",
            subjectType: "Listing",
            subjectId: listing.id,
            after: { sellerUserId: listing.sellerUserId, signals: selfDeal.signals },
            ipHash: ctx.ipHash,
          });
        });
        return { ok: false, reason: "SELF_DEALING" };
      default: {
        const exhaustive: never = selfDeal;
        throw new Error(`Unhandled self-dealing result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const holders = await deps.db.order.findMany({
    where: { listingId: listing.id, status: "CREATED" },
    include: { payments: { select: { checkoutSessionId: true } } },
  });
  for (const held of holders) {
    const stale = !held.paymentDueAt || held.paymentDueAt <= now;
    if (!stale && held.buyerUserId !== input.buyerUserId) return { ok: false, reason: "LISTING_RESERVED" };
    for (const p of held.payments) await deps.payments.expireCheckout(p.checkoutSessionId).catch(() => undefined);
    await deps.db.$transaction(async (tx) => {
      await transition(tx, held, "PAYMENT_WINDOW_EXPIRED");
      await tx.payment.updateMany({ where: { orderId: held.id, status: "REQUIRES_PAYMENT" }, data: { status: "FAILED" } });
    });
  }

  const rates = feeRates(config);
  const prices = priceBreakdown(listing.askingPriceCents, rates);
  let orderId: string;
  try {
    const order = await deps.db.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          listingId: listing.id,
          buyerUserId: input.buyerUserId,
          sellerUserId: listing.sellerUserId,
          storefrontId: storefront.id,
          source: "FIXED",
          askingPriceCents: prices.askingCents,
          buyerFeeBps: rates.buyerFeeBps,
          buyerFeeCents: prices.buyerFeeCents,
          buyerPriceCents: prices.buyerPriceCents,
          sellerFeeBps: rates.sellerFeeBps,
          sellerFeeCents: prices.sellerFeeCents,
          sellerPayoutCents: prices.sellerPayoutCents,
          platformFeeCents: prices.platformFeeCents,
          shippingCents: listing.shippingCents,
          paymentDueAt: new Date(now.getTime() + config.checkoutHoldMinutes * 60_000),
        },
      });
      await writeAuditEvent(tx, {
        actorUserId: input.buyerUserId,
        actorType: "USER",
        action: "order.created",
        subjectType: "Order",
        subjectId: created.id,
        after: {
          listingId: listing.id,
          askingPriceCents: prices.askingCents,
          buyerPriceCents: prices.buyerPriceCents,
          sellerPayoutCents: prices.sellerPayoutCents,
          platformFeeCents: prices.platformFeeCents,
          shippingCents: listing.shippingCents,
        },
        ipHash: ctx.ipHash,
      });
      return created;
    });
    orderId = order.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, reason: "LISTING_RESERVED" };
    }
    throw err;
  }

  const order = await deps.db.order.findUniqueOrThrow({ where: { id: orderId } });
  try {
    const url = await openCheckoutSession(deps, order, { id: listing.id, title: listing.title }, input.buyerEmail, order.paymentDueAt!);
    return { ok: true, orderId, url };
  } catch (err) {
    await deps.db.$transaction((tx) => transition(tx, order, "PAYMENT_WINDOW_EXPIRED"));
    throw err;
  }
}

/** Opens a hosted checkout for an existing unpaid order: the buyer price plus shipping, never a fee on top. */
export async function openCheckoutSession(
  deps: OrdersDeps,
  order: Pick<Order, "id" | "buyerPriceCents" | "shippingCents">,
  listing: { id: string; title: string },
  buyerEmail: string,
  expiresAt: Date,
): Promise<string> {
  const checkout = await deps.payments.createCheckout({
    orderId: order.id,
    lines: [
      { name: listing.title, amountCents: order.buyerPriceCents },
      ...(order.shippingCents > 0 ? [{ name: "Shipping (US)", amountCents: order.shippingCents }] : []),
    ],
    transferGroup: `order_${order.id}`,
    customerEmail: buyerEmail,
    successUrl: `${deps.appUrl}/orders/${order.id}?paid=1`,
    cancelUrl: `${deps.appUrl}/listings/${listing.id}`,
    expiresAt,
    automaticTax: deps.automaticTax ?? false,
  });
  await deps.db.payment.create({
    data: {
      orderId: order.id,
      provider: deps.payments.name,
      checkoutSessionId: checkout.checkoutSessionId,
      amountCents: order.buyerPriceCents + order.shippingCents,
      status: "REQUIRES_PAYMENT",
    },
  });
  return checkout.url;
}
