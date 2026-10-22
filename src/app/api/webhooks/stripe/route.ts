import { processPaymentEvent } from "@/domains/orders/payment-events";
import { PaymentWebhookSignatureError } from "@/domains/payments/provider";
import { ordersDeps } from "@/lib/payments/orders-deps";

/**
 * Stripe payments webhook (platform + Connect). Events: checkout.session.completed,
 * checkout.session.expired, account.updated (Connect), charge.dispute.created.
 */
export async function POST(request: Request) {
  const deps = ordersDeps();
  const rawBody = await request.text();
  let event;
  try {
    event = await deps.payments.parseWebhook(rawBody, request.headers.get("stripe-signature"));
  } catch (err) {
    if (err instanceof PaymentWebhookSignatureError) return new Response("Invalid signature", { status: 400 });
    throw err;
  }
  if (!event) return new Response("Ignored", { status: 200 });
  return Response.json(await processPaymentEvent(deps, event));
}
