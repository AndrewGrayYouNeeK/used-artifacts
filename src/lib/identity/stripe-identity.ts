import "server-only";
import Stripe from "stripe";
import {
  WebhookSignatureError,
  type IdentityProvider,
  type VerificationEvent,
  type VerificationEventKind,
  type VerifiedDocument,
} from "@/domains/identity/verification/provider";

const EVENT_KINDS: Record<string, VerificationEventKind> = {
  "identity.verification_session.processing": "PROCESSING",
  "identity.verification_session.verified": "VERIFIED",
  "identity.verification_session.requires_input": "REQUIRES_INPUT",
  "identity.verification_session.canceled": "CANCELED",
};

/**
 * Stripe Identity: government ID + live selfie. Reading the document number
 * needs a restricted key with sensitive verification-result access, which
 * Stripe grants on request (BUILD_PLAN 7).
 */
export class StripeIdentityProvider implements IdentityProvider {
  readonly name = "stripe";
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createSession(input: { userId: string; returnUrl: string }) {
    const session = await this.stripe.identity.verificationSessions.create({
      type: "document",
      client_reference_id: input.userId,
      metadata: { userId: input.userId },
      return_url: input.returnUrl,
      options: {
        document: {
          allowed_types: ["driving_license", "passport", "id_card"],
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
    });
    if (!session.url) throw new Error("Stripe did not return a verification URL");
    return { sessionId: session.id, url: session.url };
  }

  async fetchVerifiedDocument(sessionId: string): Promise<VerifiedDocument | null> {
    const session = await this.stripe.identity.verificationSessions.retrieve(sessionId, {
      expand: ["verified_outputs.dob", "last_verification_report.document.number", "last_verification_report.document.dob"],
    });
    const report = session.last_verification_report;
    const doc = report && typeof report !== "string" ? report.document : null;
    const outputs = session.verified_outputs;
    const dob = outputs?.dob ?? doc?.dob;
    const firstName = outputs?.first_name ?? doc?.first_name;
    const lastName = outputs?.last_name ?? doc?.last_name;
    if (
      !doc?.number ||
      !doc.issuing_country ||
      !doc.type ||
      !firstName ||
      !lastName ||
      !dob?.year ||
      !dob.month ||
      !dob.day
    ) {
      return null;
    }
    return {
      firstName,
      lastName,
      dob: { year: dob.year, month: dob.month, day: dob.day },
      documentNumber: doc.number,
      documentType: doc.type,
      issuingCountry: doc.issuing_country,
    };
  }

  parseWebhook(rawBody: string, signatureHeader: string | null): VerificationEvent | null {
    if (!signatureHeader) throw new WebhookSignatureError("Missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (err) {
      throw new WebhookSignatureError(err instanceof Error ? err.message : "Invalid signature");
    }
    const kind = EVENT_KINDS[event.type];
    if (!kind) return null;
    const session = event.data.object as Stripe.Identity.VerificationSession;
    return {
      eventId: event.id,
      kind,
      sessionId: session.id,
      errorCode: session.last_error?.code ?? null,
    };
  }
}
