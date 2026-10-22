import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ShippingTracker } from "@/domains/orders/deps";

/** EasyPost carrier tracking: trackers are created on ship, delivered events arrive by webhook. */
export class EasyPostTracker implements ShippingTracker {
  readonly name = "easypost";

  constructor(private readonly apiKey: string) {}

  async register(input: { carrier: string; trackingNumber: string }) {
    const res = await fetch("https://api.easypost.com/v2/trackers", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tracker: { tracking_code: input.trackingNumber, carrier: input.carrier } }),
    });
    if (!res.ok) throw new Error(`EasyPost tracker failed: ${res.status}`);
    const tracker = (await res.json()) as { id?: string };
    return { trackerId: tracker.id ?? null };
  }
}

export interface CarrierDelivery {
  trackingNumber: string;
  deliveredAt: Date;
}

/** Verifies the X-Hmac-Signature header and returns a delivery, or null for other updates. */
export function parseEasyPostWebhook(rawBody: string, signature: string | null, secret: string): CarrierDelivery | null {
  const expected = `hmac-sha256-hex=${createHmac("sha256", secret.normalize("NFKD")).update(rawBody).digest("hex")}`;
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid EasyPost signature");
  }
  const event = JSON.parse(rawBody) as {
    description?: string;
    result?: {
      tracking_code?: string;
      status?: string;
      tracking_details?: { status?: string; datetime?: string }[];
    };
  };
  const tracker = event.result;
  if (event.description !== "tracker.updated" || tracker?.status !== "delivered" || !tracker.tracking_code) return null;
  const delivered = tracker.tracking_details?.findLast((d) => d.status === "delivered")?.datetime;
  return { trackingNumber: tracker.tracking_code, deliveredAt: delivered ? new Date(delivered) : new Date() };
}
