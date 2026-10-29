import { randomUUID } from "node:crypto";
import {
  WebhookSignatureError,
  type IdentityProvider,
  type VerificationEvent,
  type VerifiedDocument,
} from "./provider";

/**
 * Local stand-in for Stripe Identity (dev and tests). Sessions open a dev page
 * where the developer types the "document" details; the server never accepts
 * this provider in production (see identityEnv).
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly name = "fake";
  private readonly documents = new Map<string, VerifiedDocument>();

  constructor(private readonly appUrl: string) {}

  async createSession() {
    const sessionId = `fake_vs_${randomUUID()}`;
    return { sessionId, url: `${this.appUrl}/account/verify/dev?session=${encodeURIComponent(sessionId)}` };
  }

  setDocument(sessionId: string, doc: VerifiedDocument) {
    this.documents.set(sessionId, doc);
  }

  async fetchVerifiedDocument(sessionId: string) {
    return this.documents.get(sessionId) ?? null;
  }

  /** The fake has no signed webhooks; the dev page reports outcomes in-process instead. */
  parseWebhook(): VerificationEvent | null {
    throw new WebhookSignatureError("The fake identity provider does not accept webhooks.");
  }
}
