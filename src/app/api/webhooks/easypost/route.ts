import { shippingEnv } from "@/config/env";
import { recordCarrierDelivered } from "@/domains/orders/fulfillment";
import { ordersDeps } from "@/lib/payments/orders-deps";
import { parseEasyPostWebhook } from "@/lib/shipping/easypost";

/** EasyPost tracker.updated webhook: a "delivered" status starts the buyer-protection hold. */
export async function POST(request: Request) {
  const env = shippingEnv();
  if (env.SHIPPING_TRACKER !== "easypost" || !env.EASYPOST_WEBHOOK_SECRET) {
    return new Response("Tracking webhooks are not configured", { status: 404 });
  }
  const rawBody = await request.text();
  let delivery;
  try {
    delivery = parseEasyPostWebhook(rawBody, request.headers.get("x-hmac-signature"), env.EASYPOST_WEBHOOK_SECRET);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  if (!delivery) return new Response("Ignored", { status: 200 });
  return Response.json(await recordCarrierDelivered(ordersDeps(), delivery));
}
