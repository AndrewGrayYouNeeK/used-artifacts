# Used Artifacts — Build Plan

Status: **DRAFT, awaiting owner approval.** No application code has been written yet. This plan covers the stack, the data model, the architecture, phased milestones mapped to the 11 roadmap sections, third-party services, and open legal questions.

Repo state when this was written: one commit with only `README.md` ("marketplace for preloved goods with founders badge program"). Nothing exists yet to migrate or stay compatible with.

---

## 1. Guiding principles

1. **Compliance is enforced in the data model, not just in policy text.** A listing cannot be published without a signed provenance statement, a verified seller, and passing the prohibited-item checks.
2. **Money only moves on real events.** Escrow releases, referral payouts, and badge progress are all driven by the same `Order` state machine. Nothing is credited for signups, listings, or recruiting alone.
3. **Everything privileged is audited.** Every admin action, money movement, compliance decision, and auth-sensitive event writes to an append-only audit log.
4. **The AI suggests and never certifies.** Analyzer output is advisory, labeled with its confidence, and never shown as authentication. The analyzer is never allowed to say an item is "Indian-made" (or anything equivalent).
5. **Feature flags gate anything legally unresolved.** For example, auctions stay behind a flag until the Kentucky licensing question is answered.

---

## 2. Tech stack recommendation

| Layer | Choice | Rationale |
|---|---|---|
| Language | **TypeScript** end to end | One language for the UI, API, jobs, and shared validation schemas. |
| Web framework | **Next.js (App Router)** | Server components and server actions, plus SEO for listing pages, which matters for marketplace discovery. Large ecosystem. |
| Validation | **Zod** | One set of schemas shared by forms, server actions, webhooks, and AI-output parsing. |
| Database | **PostgreSQL** (managed: Neon or Supabase Postgres) | Relational integrity for orders, bids, and ledgers. Row locking for bid races, recursive CTEs for circle-trade detection, and built-in full-text search for v1 search. |
| ORM | **Prisma** | Typed schema and migrations. For hot paths that need `SELECT … FOR UPDATE` (bid placement, ledger posting), drop to raw SQL through `prisma.$queryRaw`. |
| Payments | **Stripe Connect (Express accounts)** using *separate charges and transfers* | The platform charges the buyer, holds the funds, and only transfers to the seller's connected account after delivery is confirmed. Stripe handles seller KYC, 1099-K forms, and payouts, so the platform never acts as a money transmitter itself. |
| Identity verification | **Stripe Identity** (alternatives: Persona, Veriff) | Document check plus selfie. It is in the same vendor relationship as payments, and it returns stable document attributes we can hash to enforce one identity per account. |
| Auth | **Auth.js (NextAuth) with a custom credentials flow**, plus passkeys/TOTP later | We need full control over the password-reset flow (roadmap item 10), so a hosted provider that lets admins set passwords is a poor fit. Passwords hashed with argon2id. |
| Background jobs | **pg-boss** (Postgres-backed queue) on a long-running worker. Alternative: Inngest | Auction closes, payment-window expiries, escrow auto-release timers, fraud scans, and AI jobs all need durable, exactly-once-ish scheduling. Keeping the queue in Postgres means no extra infrastructure. |
| Realtime (auctions) | **Server-Sent Events** from the worker/app, fanned out via Postgres `LISTEN/NOTIFY`. Upgrade path: Ably or Pusher | Live bid updates without managing WebSocket infrastructure at beta scale. |
| File storage | **Cloudflare R2** or **S3**, with signed uploads | Listing photos, provenance documents, and grading images. Private bucket for ID and provenance documents. |
| Image processing | **sharp** plus perceptual hashing (pHash/dHash) | Thumbnails, EXIF stripping (privacy: removes GPS), and duplicate-image detection, which feeds self-reselling and circle-trade detection. |
| AI vision | **Provider-agnostic adapter** over OpenAI / Anthropic / Google vision models | Roadmap item 8 says to use existing APIs. The adapter lets us swap providers and A/B test them. Output must be structured JSON validated with Zod. |
| Email | **Postmark** (or Resend) | Transactional email is critical here: verification and password-reset links. Postmark has a strong deliverability record. |
| Hosting | **Vercel** for the Next.js app, plus **Render/Fly.io** for the worker process | Vercel is fine for request/response work. Auction timers need an always-on worker. |
| Observability | **Sentry** (errors), **PostHog** (product analytics and feature flags), structured logs | PostHog flags gate auctions, paid tiers, and the grading module. |
| Testing | **Vitest** (unit), **Playwright** (end to end), Stripe test mode plus `stripe-cli` webhook forwarding | |
| CI | GitHub Actions: typecheck, lint, test, `prisma migrate diff` check | |

**Alternatives considered:**

- **Supabase-everything** (Supabase Auth, Postgres, Storage). This is faster to start, but Supabase Auth's reset and admin flows are harder to lock down to "only the user completes the reset". We may still use Supabase as the Postgres host.
- **Rails or Django monolith.** These are strong for admin-heavy apps, but the owner's example stack is Next.js/TypeScript, and sharing types across UI, API, and AI parsing is valuable.
- **A dedicated escrow provider** (for example Escrow.com). This is true licensed escrow, but it is clunky for high-volume, low-ticket marketplaces. We should revisit it if counsel says the Stripe hold model isn't enough (see the open legal questions).

---

## 3. Architecture

```
                ┌────────────────────────── Next.js app (Vercel) ───────────────────────────┐
 Browser ──────▶│ Public pages (SSR/SEO) · Seller/Buyer dashboards · Owner GM dashboard       │
   ▲  SSE       │ Server actions / route handlers ── Zod ── Domain services ── Prisma ──┐     │
   │            │ Webhooks: /api/webhooks/stripe, /api/webhooks/identity                │     │
   │            └───────────────────────────────────────────────────────────────────────┼─────┘
   │                                                                                    ▼
   │            ┌──────────── Worker (Render/Fly) ────────────┐               ┌──────────────┐
   └────────────│ pg-boss jobs: auction close, payment window,│◀─────────────▶│  PostgreSQL  │
                │ escrow auto-release, fraud scans, AI analyze,│   LISTEN/     │  (+ audit    │
                │ referral accrual, badge recompute, emails    │   NOTIFY      │   log, ledger)│
                └──────┬───────────────┬───────────────┬───────┘               └──────────────┘
                       ▼               ▼               ▼
                  Stripe Connect   Vision API(s)    Postmark / R2 / Stripe Identity
```

### 3.1 Module boundaries (one folder per domain under `src/domains/*`)

- `identity`: users, sessions, ID verification, the one-identity rule, password reset.
- `tenancy`: storefronts (seller tenants), staff roles within a storefront.
- `catalog`: listings, photos, categories, provenance statements, prohibited-item screening.
- `auctions`: auction config, bids, retractions, closing, second-chance and relist logic.
- `orders`: checkout, the order state machine, shipping and tracking, delivery confirmation, disputes.
- `payments`: Stripe Connect onboarding, charges, holds, transfers, refunds, and an internal double-entry **ledger**.
- `trust`: fraud signals, the account-linkage graph, shill and circle-trade detectors, enforcement actions and penalties.
- `growth`: membership tiers, referrals, badges.
- `ai`: the vision adapter, the analysis pipeline, the guardrail post-processor.
- `grading`: authenticators, rubrics, submissions, results, certificates (roadmap item 11; the schema ships now, the UI ships later).
- `admin`: the GM dashboard, moderation queues, the audit log viewer.
- `audit`: the append-only event writer, used by every other module.

### 3.2 What "multi-tenant" means here (needs owner confirmation)

Proposed interpretation: **multi-vendor marketplace**. Every seller gets a **Storefront** (tenant) with its own branding, policies, payout account, and optional staff members. Buyers shop across all storefronts. Tenant isolation is enforced in the domain-service layer: every query is scoped by `storefrontId` for seller and staff actions, and Postgres row-level security can be added later as a second layer. The schema leaves room for the alternative meaning (white-label sub-marketplaces) but does not build it. See the open questions.

### 3.3 Order and escrow state machine (roadmap item 4)

```
CREATED ─pay─▶ PAID_HELD ─ship─▶ SHIPPED ─carrier delivered─▶ DELIVERED
   │              │                                              │
   │ payment      │ seller no-ship (N days)                      ├─ buyer confirms ─▶ RELEASED ─▶ (transfer to seller)
   │ window       ▼                                              ├─ no response in X days ─▶ AUTO_RELEASED
   │ expires   CANCELLED_REFUNDED                                └─ buyer disputes ─▶ DISPUTED ─▶ RESOLVED_{RELEASE|REFUND|PARTIAL}
   ▼
 EXPIRED ─▶ (auction: offer to next bidder or relist)
```

- The charge goes to the platform. The seller's share is a **Transfer** created on release, using `source_transaction` to link it to the charge. The platform fee is retained; the referral share is carved out of it (roadmap item 6).
- Auto-release after X days requires carrier-confirmed delivery. Proposed default: 3 days after delivery, configurable by the owner.
- Every transition writes ledger entries and an audit event. Transitions happen only in `orders/stateMachine.ts`, which rejects illegal edges.

### 3.4 Auction engine (roadmap item 3)

- **Bid placement:** in a single transaction, `SELECT … FOR UPDATE` on the auction row, validate (bidder is not the seller, not a linked account, KYC passed, above the increment, auction is live), insert the bid, update the cached high bid, then `NOTIFY`.
- **Proxy (max) bidding** with a public increment table.
- **Soft close (anti-sniping):** a bid in the final N minutes extends the end time. Proposed: 2 minutes, configurable.
- **No-reserve:** the highest valid bid wins. The seller cannot cancel once a bid exists (except for illegality takedowns, which the owner handles and which are audited).
- **Reserve auctions:** the reserve is hidden. The UI shows "reserve met/not met".
- **Retraction limits:** a bid may be retracted only for an obvious typo (for example, it's ≥10× the prior bid), when the description changed materially after the bid, or when the seller can't be contacted. Never in the final 12 hours, except a same-minute typo. There is a per-account quota (for example, 1 per 90 days) and every retraction is recorded and visible to the owner.
- **Payment window:** the winner must pay within N hours (proposed: 48). On expiry the order goes to `EXPIRED`, a non-paying-bidder strike is recorded, and the seller chooses **second-chance offer** to the next bidder or **relist**. Proposed default: automatic relist.
- **Shill detection:** see section 5.3.

### 3.5 AI photo analyzer (roadmap item 8)

Pipeline: upload, strip EXIF, compute perceptual hash, then a `vision.analyze` job, Zod-validate the output, run the **guardrail post-processor**, and store an `AiAnalysis` record that the seller can view.

- Outputs: suggested category, a candidate identification with **confidence**, a value **range** (never a point estimate), patina/wear observations, and red flags (possible human remains, funerary or ceremonial indicators, possible reproduction).
- **Guardrails (deterministic code, not just the prompt):**
  - If the category is Native American, or the model mentions tribal, cultural, or "Indian" attribution, force `uncertainty = HIGH`, attach the IACA disclosure banner, and strip any "Indian-made", "Native American made", or tribe-specific-maker claims. Those are rewritten as "style/attribution unverified".
  - Possible human remains, funerary, sacred, or cultural-patrimony red flags automatically route the listing to the **compliance review queue** and block publishing.
  - The analyzer can never set `authenticated` or a grading tier.
- The seller can accept suggestions into the listing draft, but the final listing text is the seller's attestation, not the AI's.
- Prompts and model versions are stored on each analysis so results are reproducible.

---

## 4. Data model (Prisma-style sketch; field lists abbreviated)

### 4.1 Identity and tenancy

- **User**: `id, email (unique, citext), emailVerifiedAt, passwordHash, status (ACTIVE|SUSPENDED|BANNED), role (USER|MODERATOR|OWNER), createdAt`
- **IdentityVerification**: `id, userId (unique), provider, providerSessionId, status, verifiedAt, legalName, dobYear, documentFingerprintHash (unique)`. The hash is derived from document number + country + DOB using a keyed HMAC. The **unique** constraint is what enforces one identity per account; raw document data stays at the provider.
- **Session**, **PasswordResetToken** (`tokenHash, userId, expiresAt, usedAt, requestedIp`), **EmailVerificationToken**
- **DeviceFingerprint** / **LoginEvent**: `userId, ipHash, uaHash, deviceIdHash, at`. These feed the account-linkage graph.
- **Storefront** (tenant): `id, slug, name, ownerUserId, stripeAccountId, payoutsEnabled, status, policies (json)`
- **StorefrontMember**: `storefrontId, userId, role (OWNER|STAFF)`

### 4.2 Catalog and compliance

- **Category**: `id, parentId, name, slug, isNativeAmerican (bool), requiresEnhancedReview (bool), rubricId?`
- **Listing**: `id, storefrontId, sellerUserId, categoryId, title, description, condition, format (FIXED|AUCTION), priceCents?, status (DRAFT|PENDING_REVIEW|LIVE|SOLD|REMOVED), featuredUntil?, publishedAt`
- **ListingPhoto**: `listingId, storageKey, pHash, width, height, order`
- **ProvenanceStatement**: `id, listingId, sellerUserId, statementVersion, acquisitionSource (enum: PRIVATE_LAND_WITH_PERMISSION|INHERITED|PURCHASED|OTHER), acquisitionState, acquisitionYearApprox, landownerPermissionDocKey?, priorOwnerChain (json), attestsNotFederalOrStateOrTribalLand (bool), attestsNotHumanRemainsFuneralSacredPatrimony (bool), attestsNotIndianMadeMisrepresented (bool), signedName, signedAt, ip, userAgent, signatureHash`. The statement is **immutable** once signed; edits create a new version.
- **ProvenanceStatementTemplate**: versioned legal text. Counsel must approve the text before launch.
- **ComplianceReview**: `listingId, reason (AI_FLAG|CATEGORY|REPORT|RANDOM_AUDIT), status, reviewerId, decision, notes`
- **ProhibitedTerm**: keyword and regex rules (for example "burial", "grave goods", "skull") that force review.

### 4.3 Auctions

- **Auction**: `listingId (unique), startsAt, endsAt, originalEndsAt, startingBidCents, reserveCents?, isNoReserve, incrementTableId, softCloseMinutes, status (SCHEDULED|LIVE|ENDED|SETTLED|RELISTED|CANCELLED), currentHighBidId?, paymentWindowHours`
- **Bid**: `id, auctionId, bidderUserId, amountCents, maxProxyCents?, placedAt, ip/deviceHash, status (ACTIVE|OUTBID|RETRACTED|WINNING|VOIDED_SHILL)`
- **BidRetraction**: `bidId, reason, approvedBy?, createdAt`
- **NonPayingBidderStrike**: `userId, auctionId, createdAt`

### 4.4 Orders, payments, ledger

- **Order**: `id, listingId, buyerUserId, sellerUserId, storefrontId, source (FIXED|AUCTION|SECOND_CHANCE), subtotalCents, shippingCents, taxCents, platformFeeCents, feeRateBps, status (state machine above), paymentDueAt, deliveredAt, releaseEligibleAt`
- **Shipment**: `orderId, carrier, trackingNumber, status, deliveredAt (from carrier webhook)`
- **Payment**: `orderId, stripePaymentIntentId, stripeChargeId, amountCents, status`
- **Transfer**: `orderId, stripeTransferId, amountCents, status`
- **Refund**, **Dispute**: `orderId, openedBy, reason, status, resolution, evidence keys`
- **LedgerAccount** / **LedgerEntry**: double-entry records (`debitAccount, creditAccount, amountCents, orderId?, referralId?, memo`). Accounts include `platform_revenue`, `seller_payable:{id}`, `referral_payable:{id}`, `buyer_held:{orderId}`, `stripe_fees`. This is what makes "referral paid from the platform cut" auditable.

### 4.5 Trust and safety

- **AccountLink**: `userAId, userBId, signal (SAME_DEVICE|SAME_IP|SAME_PAYMENT_FINGERPRINT|SAME_SHIPPING_ADDRESS|SAME_BANK|SAME_ID_HASH_ATTEMPT), strength, firstSeenAt`
- **FraudSignal**: `subjectType, subjectId, detector (SHILL|CIRCLE_TRADE|SELF_RESALE|RETRACTION_ABUSE|NONPAY), score, evidence (json), status`
- **EnforcementAction**: `userId, type (WARNING|BID_VOID|LISTING_REMOVED|FEE_FORFEIT|BADGE_REVOKED|SUSPENSION|BAN), reason, fraudSignalId?, actorId, expiresAt?`
- **ItemFingerprint**: `listingId, pHashes[], textHash`. Used to recognize the same item being re-listed.

### 4.6 Growth: membership, referrals, badges

- **MembershipTier**: `id, name (FREE|PLUS|PRO…), monthlyPriceCents, feeRateBps, featuredListingCredits, analyticsEnabled, earlyAccess`. Constraint: tiers contain **no** referral or recruiting multipliers. This is enforced by having no such column.
- **Membership**: `userId, tierId, stripeSubscriptionId, status, currentPeriodEnd`
- **Referral**: `id, referrerUserId, refereeUserId (unique), code, createdAt, firstSaleOrderId?`
- **ReferralEarning**: `referralId, orderId (unique per referral), kind (FIRST_SALE|ONGOING), rateBps, basisCents (= platform fee actually collected), amountCents, status (PENDING|PAYABLE|PAID|CLAWED_BACK)`. It becomes PAYABLE only when the order reaches `RELEASED`/`AUTO_RELEASED`, and it is clawed back on refund.
- **Badge**: `id, code, name, criteria (json: e.g. {completedSalesCount ≥ 10} or {gmvCents ≥ X})`
- **UserBadge**: `userId, badgeId, awardedAt, revokedAt?, basisSnapshot`. It is recomputed only from released orders that the fraud checks did not flag.

### 4.7 AI

- **AiAnalysis**: `id, listingId?, photoIds[], provider, model, promptVersion, rawOutput (json), normalizedOutput (json), uncertainty (LOW|MEDIUM|HIGH), flags[], guardrailActions[], createdAt`

### 4.8 Grading arm (schema now, features later; roadmap item 11)

- **Authenticator** (partner): `id, name, organization, credentials, specialties (category ids), status, agreementSignedAt, payoutAccount`
- **GradingTier**: enum `AUTHENTICATED | GRADED | MUSEUM_GRADE`
- **GradingRubric**: `id, categoryId (textiles|pottery|jewelry|stone tools|…), version, criteria (json: [{key, label, weight, scale}]), effectiveFrom, approvedBy`
- **GradingFeeSchedule**: `tier, categoryId?, feeCents, authenticatorShareBps`
- **GradingSubmission**: `id, listingId?, ownerUserId, categoryId, requestedTier, feeCents, paymentId, status (SUBMITTED|RECEIVED|IN_REVIEW|COMPLETED|REJECTED|RETURNED), assignedAuthenticatorId`
- **GradingResult**: `submissionId, rubricId+version, tierAwarded, criterionScores (json), overallGrade, notes, certificateNumber (unique), photos, signedBy, issuedAt, revokedAt?`
- The listing page shows the certificate. A public `/verify/{certificateNumber}` page comes later.

### 4.9 Audit

- **AuditEvent** (append-only; the DB role has INSERT only, with no UPDATE or DELETE): `id, at, actorUserId?, actorType (USER|ADMIN|SYSTEM|WEBHOOK), action, subjectType, subjectId, before (json), after (json), ip, requestId, prevHash, hash`. Each event's hash covers the previous one, so tampering is detectable.

---

## 5. How each legal and trust guardrail is enforced (roadmap item 2)

### 5.1 Provenance and prohibited items

- A listing cannot leave `DRAFT` unless it has a signed `ProvenanceStatement` (current template version), the seller has a passed `IdentityVerification`, and Stripe `payoutsEnabled` is true.
- Hard bans: human remains, funerary objects, sacred objects, and objects of cultural patrimony (the NAGPRA categories), plus anything from federal, state, or tribal land. These are enforced by the attestation, keyword rules, AI flags, and a manual review queue. Categories with `isNativeAmerican` **always** get human review before going live, at least during beta.
- IACA: no listing or AI text may say "Indian-made", "Native American made", or name a tribe as the maker unless verification exists. Before grading exists, the only mode is "style/attribution unverified". Listing text is linted at save time.
- Buyer and public "report this listing" feeds the compliance queue. Takedowns are audited.
- Records are retained (statements, IP addresses, ID verification references) to support any law-enforcement request. The retention period is an open question for counsel.

### 5.2 One identity per account

- `IdentityVerification.documentFingerprintHash` is unique. A second account presenting the same document is blocked and an `AccountLink(SAME_ID_HASH_ATTEMPT)` is recorded.
- Verification is required to **sell**, to **bid**, and to be paid referral earnings. It is optional for simple fixed-price buying in v1 (to be decided; see open questions).

### 5.3 Self-buying, self-reselling, circle trading, shill bidding

- **Self-buy / self-bid:** blocked if the buyer is the seller, a storefront member, or strongly linked (same ID hash, device, payment fingerprint, bank, or shipping address).
- **Self-reselling:** a new listing whose pHash or text matches an item recently bought or sold by a linked account is held for review.
- **Circle trading:** a nightly job runs a recursive CTE over the released-order graph, looking for cycles of length ≤ 4 within 90 days among weakly linked accounts, or the same `ItemFingerprint` returning to an earlier owner. Hits create a `FraudSignal`, and badge or referral credit for the involved orders is frozen.
- **Shill bidding:** a scoring model over linkage to the seller, the share of a bidder's bids that land on one seller, how often they bid the price up but never win, retraction history, and bid timing patterns. High scores void the bids. Penalties escalate: warning, then bid void plus fee forfeit, then suspension, then ban. The seller is also penalized when the shill is linked to them.
- Every enforcement action is audited and appealable through the owner dashboard.

---

## 6. Phased milestones (each section of the roadmap mapped to a phase)

| Phase | Theme | Roadmap sections | Exit criteria |
|---|---|---|---|
| **0** | Foundations | 1 (skeleton), 10 (audit, auth) | Repo scaffold, CI, DB, Auth.js credentials auth with email verification, **secure password reset**, `AuditEvent` writer, owner role, deploys to staging. |
| **1** | Identity and compliance core | 2 | Stripe Identity flow, one-identity uniqueness, provenance statement templates and signing, prohibited-item rules, compliance review queue, account-linkage signals collected at login and checkout. |
| **2** | Storefronts, listings, fixed-price checkout with escrow | 1, 4 | Storefront onboarding (Stripe Connect Express), listing CRUD with photos, search and browse, checkout, the order state machine, shipping and tracking, buyer confirmation and auto-release, disputes, ledger, self-buy block. |
| **3** | AI photo analyzer | 8 | Vision adapter, analysis job, guardrail post-processor, seller accept/reject UI, auto-routing of flagged items to compliance. |
| **4** | Owner GM dashboard v1 | 10 | Users, storefronts, listings, orders, disputes, compliance queue, fraud signals, enforcement, audit-log viewer, "send reset email" (never "set password"), metrics. |
| **5** | Badges and referrals | 7, 6 | Volume-only badges computed from released orders. Referral codes, earnings from the platform fee, clawbacks, payouts via Stripe transfers, fraud freezes. |
| **6** | Auctions (behind a flag) | 3 | Auction engine, proxy bids, soft close, no-reserve rules, retraction limits, payment window and relist/second chance, shill detection and penalties. **Not enabled in production until legal question L1 is resolved.** |
| **7** | **Closed beta** | 9 | Invite-only (invite codes issued by the owner), small trusted group, feedback channel, compliance review on 100% of listings, daily fraud review, kill switches. |
| **8** | Membership tiers | 5 | Stripe Billing subscriptions, fee-rate overrides by tier, featured listings, seller analytics, early-access flags. No recruiting perks. |
| **9** | Circle-trade detection hardening and public launch readiness | 2, 10 | Graph job tuned on beta data, appeal flows, load testing auctions, counsel sign-off on all legal templates. |
| **10** | Grading arm | 11 | Phase 10a: authenticator partner onboarding plus the AUTHENTICATED tier. 10b: GRADED tier with rubrics for textiles, pottery, jewelry, and stone tools. 10c: MUSEUM_GRADE tier, certificates, the public verify page, per-item grading fees. |

Notes:

- The roadmap lists beta as item 9, after paid tiers. I recommend running the beta **before** paid tiers and **with auctions off unless L1 is cleared**, so the beta tests the risky core (compliance, escrow, fraud) without also introducing billing.
- The owner dashboard (roadmap item 10) grows in every phase. Phase 4 is just where it becomes a complete tool.
- The grading schema lands in Phase 0/1 migrations even though its UI comes in Phase 10, as requested.

### 6.1 Proposed MVP (what the closed beta requires)

**In:** Phases 0 through 5 and Phase 7. That covers accounts with secure reset, ID verification and one identity per account, storefronts, fixed-price listings with signed provenance, compliance review, the AI analyzer with guardrails, Stripe Connect escrow-style holds with buyer confirmation, self-buy blocking and basic linkage detection, volume badges, referral tracking and payouts, the owner dashboard, and the audit log.

**Behind a flag / out:** auctions (pending L1), paid membership tiers, circle-trade graph detection (signals are collected; reviewers act on them manually during beta), and the grading arm (schema only).

---

## 7. Third-party services

| Service | Purpose | Notes |
|---|---|---|
| Stripe Connect (Express) | Seller onboarding, KYC, charges, holds, transfers, payouts, 1099-K | Confirm with Stripe that our hold periods are allowed (see L4). |
| Stripe Identity | Government ID plus selfie verification | Alternatives: Persona, Veriff. |
| Stripe Billing | Membership subscriptions | Phase 8. |
| Stripe Tax or TaxJar | Marketplace-facilitator sales tax collection and remittance | Required in most US states for marketplaces. |
| Shipping tracking (EasyPost or Shippo) | Labels, tracking webhooks, delivered events that drive auto-release | |
| Postmark / Resend | Transactional email (verification, reset, order events) | |
| Cloudflare R2 / AWS S3 | Photos (public through a CDN), documents (private) | |
| OpenAI / Anthropic / Google vision | Photo analyzer | Behind an adapter. Check each provider's data-retention terms; prefer zero-retention options. |
| Vercel + Render/Fly | App hosting + worker | |
| Neon / Supabase Postgres | Managed Postgres with branching for preview environments | |
| Sentry, PostHog | Errors, analytics, feature flags | |
| Cloudflare Turnstile | Bot protection on signup, bid, and reset forms | |

---

## 8. Security notes (roadmap item 10)

- **Password reset:** the user requests it, a single-use token is emailed to the **verified** address (only the hash is stored, 30-minute TTL), and the user sets a new password on that page. Afterwards all sessions are revoked and a notification email is sent. **No admin path can set or reveal a password.** The GM can only trigger the same reset email, and that action is audited. Changing the account email requires confirmation from both the old and new addresses.
- Role-based access for owner and moderator. Owner actions require re-authentication and 2FA.
- Audit-log immutability is enforced through DB grants and a hash chain. The admin viewer is read-only.
- PII minimization: ID documents stay at the identity provider. We store the hashed fingerprint and the verification status.

---

## 9. Open legal and business questions (need counsel or owner decisions)

**Legal (counsel should review before launch):**

- **L1. Kentucky auctioneer licensing (UNVERIFIED).** Does an online marketplace hosting seller-run, timed online auctions fall under KRS Chapter 330 auctioneer licensing, or is there an exemption for online platforms? Auctions stay disabled in production until counsel answers. We also need to know whether other states where users reside impose their own rules.
- **L2. ARPA / state law scope.** Federal ARPA covers federal and Indian lands, and interstate trafficking when state or local law was violated. Which state laws (unmarked-burial statutes, state-land antiquities laws, and the like) should the provenance statement cover, and should certain states' sellers or categories be geo-restricted?
- **L3. NAGPRA and the STOP Act.** Confirm the prohibited categories and definitions (human remains, funerary objects, sacred objects, cultural patrimony). Under the STOP Act (2021), should we block international shipping for Native American categories entirely?
- **L4. Escrow licensing.** Several states (for example California) regulate "escrow" businesses. Can we hold funds via Stripe Connect's separate-charges-and-transfers model and describe it as "buyer protection hold" rather than "escrow"? What is the maximum hold Stripe permits for our account?
- **L5. Indian Arts and Crafts Act.** Approved disclosure wording. When (if ever) may a listing say "Native American made", and what verification counts (for example tribal enrollment of the maker, or a certificate)?
- **L6. Provenance attestation.** Should it be sworn under penalty of perjury (28 U.S.C. § 1746 style) or a contractual warranty? Is an e-signature enough under ESIGN/UETA? What is the record-retention period?
- **L7. Referral program.** Confirm it does not create MLM or pyramid exposure (it pays only on real sales, with no recruiting bonuses). Tax reporting for referral payouts (1099-NEC/MISC thresholds). Disclosure under the FTC endorsement guides.
- **L8. Shill-bidding penalties.** Enforceability of fee forfeiture and penalties in the Terms of Service. State consumer-protection obligations to notify affected bidders.
- **L9. Grading arm liability.** Liability for incorrect grades or authentication. Authenticator contractor agreements. Insurance for items in transit or held for grading.
- **L10. Marketplace facilitator sales tax** registration triggers, and whether Stripe Tax coverage is enough.
- **L11. Privacy.** Biometric data from selfie verification (Illinois BIPA, Texas, Washington). Use of seller photos to improve AI models.

**Business and product (owner decisions):**

- **B1.** Confirm the meaning of "multi-tenant": multi-vendor storefronts (proposed) or white-label sub-marketplaces?
- **B2. Referral math.** Is it "10% / 5% **of the platform fee**" (proposed: the referrer earns 10% of the 10% fee on the first sale, i.e. 1% of the sale, then 5% of the fee) or "10% / 5% **of the sale price**" (which would consume the platform's entire fee on the first sale)? Does "ongoing" last forever or have a cap (for example 12 months)? When a paid tier lowers the fee, is the referral computed on the reduced fee? (Proposed: yes, on the fee actually collected.)
- **B3.** Platform fee is 10% for the free tier. What fee rate and price should each paid tier have?
- **B4.** Must buyers be ID-verified to purchase at fixed price, or only to bid and sell?
- **B5.** The README mentions a "founders badge program". Is a non-volume "Founder/Beta" badge allowed, given roadmap item 7 (badges for real volume only)? Proposed: a cosmetic "Beta Founder" label kept separate from volume badges, with no fee or ranking effect.
- **B6.** What scope is "used artifacts": only archaeological and cultural artifacts, or also general antiques and collectibles? This changes category trees, review load, and how much legal exposure we carry.
- **B7.** Is shipping US-only at launch? (Proposed: yes.)
- **B8.** Auto-release window after delivery (proposed 3 days) and the auction payment window (proposed 48 hours).

---

## 10. Next step

On approval (and answers to B1–B4 at minimum), implementation starts with **Phase 0** on a new branch: Next.js/TypeScript scaffold, Prisma schema for all entities above (grading included), auth with the secure reset flow, the audit log, and CI.
