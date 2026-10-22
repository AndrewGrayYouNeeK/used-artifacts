/** Document details read once to compute fingerprints; only name and DOB year are stored. */
export interface VerifiedDocument {
  firstName: string;
  lastName: string;
  dob: { year: number; month: number; day: number };
  documentNumber: string;
  documentType: string;
  issuingCountry: string;
}

export type VerificationEventKind = "PROCESSING" | "VERIFIED" | "REQUIRES_INPUT" | "CANCELED";

export interface VerificationEvent {
  /** Provider's event id, used for idempotency. */
  eventId: string;
  kind: VerificationEventKind;
  sessionId: string;
  errorCode?: string | null;
}

export class WebhookSignatureError extends Error {}

export interface IdentityProvider {
  readonly name: string;
  createSession(input: { userId: string; returnUrl: string }): Promise<{ sessionId: string; url: string }>;
  /** Returns null when the provider can't supply every field duplicate detection needs. */
  fetchVerifiedDocument(sessionId: string): Promise<VerifiedDocument | null>;
  /** Throws WebhookSignatureError on a bad signature; returns null for events we don't handle. */
  parseWebhook(rawBody: string, signatureHeader: string | null): VerificationEvent | null;
}
