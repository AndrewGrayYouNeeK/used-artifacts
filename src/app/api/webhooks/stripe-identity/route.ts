import { processVerificationEvent } from "@/domains/identity/verification/verification";
import { WebhookSignatureError } from "@/domains/identity/verification/provider";
import { verificationDeps } from "@/lib/identity/verification-deps";

/** Stripe Identity webhook. Configure in Stripe for identity.verification_session.* events. */
export async function POST(request: Request) {
  const deps = verificationDeps();
  const rawBody = await request.text();
  let event;
  try {
    event = deps.provider.parseWebhook(rawBody, request.headers.get("stripe-signature"));
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return new Response("Invalid signature", { status: 400 });
    }
    throw err;
  }
  if (!event) return new Response("Ignored", { status: 200 });
  const result = await processVerificationEvent(deps, event);
  return Response.json(result);
}
