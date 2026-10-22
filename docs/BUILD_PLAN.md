# Used Artifacts — Build Plan

Status: **APPROVED by Andrew (2026-10-22).** Owner decisions are recorded in section 0. Phase 0 implementation is in progress. This plan covers the stack, the data model, the architecture, phased milestones mapped to the 11 roadmap sections, third-party services, and open legal questions.

---

## 0. Owner decisions (2026-10-22)

| # | Decision |
|---|---|
| B1 | **Multi-tenant** means each seller gets their own storefront under the Used Artifacts brand. White-label sub-marketplaces are out of scope. |
| B2 | **Referral payouts are a share of the SALE PRICE**, paid from the platform's cut: 10% on a recruit's first sale, then 5% on every later sale for as long as the recruit sells (it never ends). |
| B3 | **One paid tier** at $20/month. It lowers the seller fee from 10% to 5%. |
| B4 | **Buyers need ID verification only to bid or sell.** Browsing and fixed-price buying do not require it. |
| B5 | A cosmetic **"Beta Founder" badge** is allowed for the **first 100 sellers**. It has no effect on fees or ranking and is kept separate from volume badges. |
| B10 | A unique **"Proprietor" badge** for Andrew, the platform owner. It has premium, top-tier styling and is distinct from Beta Founder. It cannot be earned or bought, and code and the database enforce that **exactly one user can ever hold it**. It is shown on his owner dashboard profile and everywhere he appears (storefront, listings, bids, comments). See section 4.6a. |
| B6 | **Scope (corrected 2026-10-22): artifacts first, antiques later.** The long-term definition includes antiques, but the **first beta is artifacts only**. Antiques open once grading exists. Every category carries a `vertical` (`ARTIFACT` or `ANTIQUE`), and the `ENABLED_VERTICALS` config value controls which verticals are visible and listable, so antiques can be switched on later without a migration. Native American and archaeological categories keep the enhanced review rules. |
| B9 | **Grading is staged (roadmap item 11, revised).** Grading Stage 1 runs during the beta: 1–2 private partner authenticators for high-value pieces, results shown as listing badges, and sales-outcome data collected. Grading Stage 2 starts once patterns emerge: in-house rubrics, with partner verification before any grade goes public. See section 6.2. *The brand comes from accuracy, not from having a lab on day one.* |
| B7 | **US-only shipping** at launch. |
| B8 | **3-day hold after delivery** before auto-release. **48-hour payment window** for auction winners. |
| — | Unchanged: auctions stay off until the Kentucky licensing question (L1) is answered, and paid tiers launch after the beta. The full in-house grading program and the MUSEUM_GRADE tier still come last. |

### 0.1 Configuration values

All of these numbers are config values, not hard-coded. In Phase 0 they live in `src/config/economics.ts` and can be overridden through environment variables. A later phase moves them to an owner-editable, audited settings table.

| Key | Default | Meaning |
|---|---|---|
| `PLATFORM_FEE_BPS_FREE` | 1000 (10%) | Seller fee on the free tier |
| `PLATFORM_FEE_BPS_PAID` | 500 (5%) | Seller fee on the paid tier |
| `PAID_TIER_PRICE_CENTS` | 2000 ($20/month) | Paid tier price |
| `REFERRAL_FIRST_SALE_BPS` | 1000 (10% of sale price) | Referrer's share of the recruit's first sale |
| `REFERRAL_ONGOING_BPS` | 500 (5% of sale price) | Referrer's share of the recruit's later sales, with no end date |
| `REFERRAL_CAP_AT_PLATFORM_FEE` | `true` | If true, a referral payout can never exceed the fee the platform actually collected on that order (see 0.2) |
| `ESCROW_AUTO_RELEASE_DAYS` | 3 | Days after carrier-confirmed delivery before funds auto-release |
| `AUCTION_PAYMENT_WINDOW_HOURS` | 48 | Time an auction winner has to pay |
| `ENABLED_VERTICALS` | `ARTIFACT` | Comma-separated list of verticals open for listing and browsing. Add `ANTIQUE` once grading exists. |
| `HIGH_VALUE_THRESHOLD_CENTS` | 50000 ($500), placeholder | Asking price at or above which a listing is eligible for partner authentication in Grading Stage 1. Andrew sets the real number. |

(bps = basis points; 100 bps = 1%.)

### 0.2 Referral economics: for Andrew to review

With the numbers above, the platform's net take on a referred seller's sales is as follows. All figures are percentages of the sale price, before Stripe processing fees.

| Seller | Sale | Platform fee | Referral payout | **Platform nets** |
|---|---|---|---|---|
| Free tier | Recruit's first sale | 10% | 10% | **0%** |
| Free tier | Later sales | 10% | 5% | 5% |
| Paid tier | Recruit's first sale | 5% | 10%, capped to 5% | **0%**. Without the cap the platform would net **−5%** |
| Paid tier | Later sales | 5% | 5% | **0%**, forever |

- **The platform nets 0% on every referred seller's first sale.**
- **The platform nets 0% on all ongoing sales by a referred seller on the paid tier** (5% fee minus 5% referral). That seller's only revenue to the platform is the $20/month subscription.
- **Stripe processing fees** (about 2.9% + 30¢ per card charge) are paid by the platform out of its fee, so a "0% net" row is actually a **loss of roughly 3% per order**. Possible fixes are to pass processing fees to the buyer or seller, or to compute referrals on the fee net of processing costs.
- The paid-tier first sale is the one case where the referral is larger than the fee. Because payouts come "from the platform's cut", the plan caps the payout at the fee collected (`REFERRAL_CAP_AT_PLATFORM_FEE=true`). Andrew can turn the cap off if he prefers to pay the full 10% from other revenue.
- Since ongoing referrals never end, the referral liability grows with every referred seller. The ledger tracks it in a separate `referral_payable` account so it is visible on the GM dashboard.

### 0.3 Supabase note

The plan uses **Auth.js**, not Supabase Auth, and Phase 0 is built that way. Supabase may still host Postgres. **If Supabase Auth is ever adopted**, Andrew must set the **Site URL** and the **redirect allow-list** by hand in the Supabase dashboard under **Authentication > URL configuration**. Otherwise verification and password-reset links will point to the wrong host or be rejected.

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

### 3.2 What "multi-tenant" means here (confirmed, B1)

It is a **multi-vendor marketplace**. Every seller gets a **Storefront** (tenant) under the Used Artifacts brand, with its own name, policies, payout account, and optional staff members. Buyers shop across all storefronts. Tenant isolation is enforced in the domain-service layer: every query is scoped by `storefrontId` for seller and staff actions, and Postgres row-level security can be added later as a second layer. White-label sub-marketplaces are out of scope.

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

- **Category**: `id, parentId, name, slug, vertical (ARTIFACT|ANTIQUE), isNativeAmerican (bool), requiresEnhancedReview (bool), rubricId?`. Listings and browse are filtered to `ENABLED_VERTICALS`.
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
- **ReferralEarning**: `referralId, orderId (unique per referral), kind (FIRST_SALE|ONGOING), rateBps, basisCents (= sale price per B2), platformFeeCents, cappedAtFee (bool), amountCents, status (PENDING|PAYABLE|PAID|CLAWED_BACK)`. `amountCents = basisCents × rateBps`, capped at `platformFeeCents` when `REFERRAL_CAP_AT_PLATFORM_FEE` is on. It becomes PAYABLE only when the order reaches `RELEASED`/`AUTO_RELEASED`, and it is clawed back on refund.
- **Badge**: `id, code, name, criteria (json: e.g. {completedSalesCount ≥ 10} or {gmvCents ≥ X})`
- **Badge** gains `kind (VOLUME|COSMETIC)`. VOLUME badges are computed from sales. COSMETIC covers "Beta Founder", which goes to the first 100 sellers and is capped by `BETA_FOUNDER_LIMIT=100`.
- **UserBadge**: `userId, badgeId, awardedAt, revokedAt?, basisSnapshot`. Volume badges are recomputed only from released orders that the fraud checks did not flag.

### 4.6a Proprietor badge (B10)

The Proprietor badge is **not** a `Badge` row, so the generic badge-award code can never touch it. It lives in its own singleton table.

- **Proprietor**: `id Int @id @default(1)` with `CHECK (id = 1)`, plus `userId (unique, FK → User)` and `assignedAt`. Because `id` can only be 1, the table can hold at most one row, so at most one person can ever be Proprietor.
- **Database triggers** (raw SQL in the migration):
  - **Insert:** rejected unless the target user has `role = OWNER`.
  - **Update or delete:** always rejected. Once the row exists, no admin action, API call, or ordinary migration can move or remove it.
  - **Demotion:** changing the role of the Proprietor's `User` row away from OWNER is rejected.
- **Application guard:** there is no API route, server action, or admin UI that grants the badge. It is created only by the one-time `npm run proprietor:assign` script, which reads `PROPRIETOR_EMAIL`, refuses if a row already exists, and writes an audit event. The generic `awardBadge()` function has no code path to it.
- **What we can't guarantee:** a Postgres superuser running hand-written SQL could still drop the triggers. Production should run the app under a non-superuser role that has no `TRIGGER` or DDL rights on this table. A genuine ownership transfer (for example a sale of the business) would be a deliberate, documented manual database procedure, not a product feature.
- **Display:** a shared `<UserIdentity>` component renders a user's name and badges everywhere a user appears: the owner dashboard profile now, and storefronts, listings, bids, and comments as those features ship. It renders the Proprietor badge first, with premium styling (gold gradient, distinct icon), before any other badge. Comments are not in the data model yet; when added they will use the same component.

### 4.7 AI

- **AiAnalysis**: `id, listingId?, photoIds[], provider, model, promptVersion, rawOutput (json), normalizedOutput (json), uncertainty (LOW|MEDIUM|HIGH), flags[], guardrailActions[], createdAt`

### 4.8 Grading arm (roadmap item 11; the whole schema ships in Phase 0)

- **Authenticator** (partner): `id, name, organization, credentials, specialties (category ids), status, agreementSignedAt, payoutAccount`. In Grading Stage 1 there are only 1–2 of these.
- **GradingTier**: enum `AUTHENTICATED | GRADED | MUSEUM_GRADE`
- **GradingRubric**: `id, categoryId (textiles|pottery|jewelry|stone tools|…), version, criteria (json: [{key, label, weight, scale}]), effectiveFrom, approvedBy`. Written in Grading Stage 2 from patterns in the Stage 1 data.
- **GradingFeeSchedule**: `tier, categoryId?, feeCents, authenticatorShareBps`
- **GradingSubmission**: `id, listingId?, ownerUserId, categoryId, requestedTier, feeCents, paymentId, status (SUBMITTED|RECEIVED|IN_REVIEW|COMPLETED|REJECTED|RETURNED), assignedAuthenticatorId`
- **GradingResult**: `submissionId, rubricId? + version, tierAwarded, criterionScores (json), overallGrade, notes, certificateNumber (unique), photos, gradedByAuthenticatorId?, gradedByUserId? (in-house grader, e.g. Andrew), status (DRAFT|PENDING_VERIFICATION|VERIFIED|PUBLISHED|REJECTED|REVOKED), publishedAt, revokedAt?`.
  - Stage 1: a partner authenticator produces the result directly. The tier is AUTHENTICATED and there is no rubric.
  - Stage 2: an in-house grader produces it and it stays `PENDING_VERIFICATION`. **It can only reach `PUBLISHED` after a partner verification with decision AGREE or ADJUST.**
- **GradeVerification**: `id, gradingResultId, authenticatorId, decision (AGREE|ADJUST|DISAGREE), adjustedScores (json)?, notes, decidedAt`. Partner agreement with in-house grades, per category and per grader, is tracked on the GM dashboard as the core accuracy metric.
- **ListingBadge** (display): derived from a `PUBLISHED` GradingResult, for example "Authenticated by partner". The listing page shows it with the certificate number. A public `/verify/{certificateNumber}` page comes later.

### 4.8a Sales-outcome data (Grading Stage 1 data collection)

This data supports "what sells and what doesn't" analysis, and the Stage 2 rubrics are later written from it.

- **ListingDailyStat**: `listingId, date, views, saves, offers, bids`. A daily rollup, so we don't store a row per view.
- **ListingPriceChange**: `listingId, oldPriceCents, newPriceCents, changedAt`
- **ListingOutcome**: one row per listing once it leaves `LIVE`. Fields: `listingId (unique), categoryId, vertical, outcome (SOLD|EXPIRED|WITHDRAWN|REMOVED|UNSOLD_AUCTION), firstAskCents, finalAskCents, salePriceCents?, daysLive, totalViews, totalSaves, photoCount, sellerConditionGrade, wasAuthenticated (bool), gradingTier?, aiValueLowCents?, aiValueHighCents?, aiUncertainty?, closedAt`. This is snapshotted at close so later edits don't rewrite history.

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
- Verification is required to **sell**, to **bid**, and to be paid referral earnings. It is **not** required to browse or to buy at a fixed price (B4). Self-buy blocking for unverified buyers relies on the device, payment, and address linkage signals.

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
| **7a** | **Grading Stage 1 (during beta)** | 11 | 1–2 private partner authenticators onboarded. Owner-assigned authentication of high-value pieces (at or above `HIGH_VALUE_THRESHOLD_CENTS`). AUTHENTICATED results shown as listing badges. `ListingOutcome`, `ListingDailyStat`, and `ListingPriceChange` populated, with a basic "what sells" report on the GM dashboard. |
| **10** | Grading Stage 2 and the full grading arm | 11 | Starts **once patterns emerge** in the Stage 1 data. In-house condition rubrics per category (textiles, pottery, stone tools, jewelry). Andrew's grades go to `PENDING_VERIFICATION`, and the same partner authenticators verify them before they go public. Accuracy (agreement-rate) dashboard. Per-item grading fees. After that: the MUSEUM_GRADE tier, the public verify page, and **opening the ANTIQUE vertical** via `ENABLED_VERTICALS`. |

Notes:

- The roadmap lists beta as item 9, after paid tiers. I recommend running the beta **before** paid tiers and **with auctions off unless L1 is cleared**, so the beta tests the risky core (compliance, escrow, fraud) without also introducing billing.
- The owner dashboard (roadmap item 10) grows in every phase. Phase 4 is just where it becomes a complete tool.
- The full grading schema, including Stage 2 verification and the sales-outcome tables, lands in the Phase 0 migration, so beta data is captured from day one.

### 6.1 MVP (what the closed beta requires)

**In:** Phases 0 through 5, plus Phase 7 and Grading Stage 1 (7a). That covers:
- accounts with secure reset;
- ID verification and one identity per account;
- storefronts;
- fixed-price listings with signed provenance, **artifact categories only**;
- compliance review;
- the AI analyzer with guardrails;
- Stripe Connect escrow-style holds with buyer confirmation;
- self-buy blocking and basic linkage detection;
- volume badges plus the cosmetic Beta Founder badge;
- referral tracking and payouts;
- partner authentication badges on high-value pieces, and sales-outcome data capture;
- the owner dashboard and the audit log.

**Behind a flag / out:** auctions (pending L1), paid membership tiers, circle-trade graph detection (signals are collected; reviewers act on them manually during beta), the antiques vertical, in-house rubric grading (Stage 2), and MUSEUM_GRADE.

### 6.2 Grading roadmap (roadmap item 11, revised by Andrew)

1. **Grading Stage 1, during the beta.** Partner with 1–2 private authenticators for high-value pieces. Show their results as listing badges. Collect sales data on what sells and what doesn't (section 4.8a).
2. **Grading Stage 2, once patterns emerge.** Write in-house condition rubrics per category (textiles, pottery, stone tools, jewelry). Andrew grades. The same partner authenticators verify his grades before they go public, and their agreement rate is tracked.
3. **Later.** Per-item grading fees at scale, the MUSEUM_GRADE tier, the public certificate verification page, and opening the antiques vertical.

The brand is built on accuracy, not on having a lab on day one.

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

**Business and product.** Answered on 2026-10-22; see section 0. The original questions are kept here for the record.

- **B1.** Confirm the meaning of "multi-tenant": multi-vendor storefronts (proposed) or white-label sub-marketplaces?
- **B2. Referral math.** Is it "10% / 5% **of the platform fee**" (proposed: the referrer earns 10% of the 10% fee on the first sale, i.e. 1% of the sale, then 5% of the fee) or "10% / 5% **of the sale price**" (which would consume the platform's entire fee on the first sale)? Does "ongoing" last forever or have a cap (for example 12 months)? When a paid tier lowers the fee, is the referral computed on the reduced fee? (Proposed: yes, on the fee actually collected.)
- **B3.** Platform fee is 10% for the free tier. What fee rate and price should each paid tier have?
- **B4.** Must buyers be ID-verified to purchase at fixed price, or only to bid and sell?
- **B5.** The README mentions a "founders badge program". Is a non-volume "Founder/Beta" badge allowed, given roadmap item 7 (badges for real volume only)? Proposed: a cosmetic "Beta Founder" label kept separate from volume badges, with no fee or ranking effect.
- **B6.** What scope is "used artifacts": only archaeological and cultural artifacts, or also general antiques and collectibles? This changes category trees, review load, and how much legal exposure we carry.
- **B7.** Is shipping US-only at launch? (Proposed: yes.)
- **B8.** Auto-release window after delivery (proposed 3 days) and the auction payment window (proposed 48 hours).

---

## 10. Phase 0 scope (in progress)

Built on the same branch and PR as this plan:

- Next.js (App Router) + TypeScript scaffold, with ESLint and Vitest.
- Prisma schema for all entities above, grading included, with an initial migration.
- `src/config/economics.ts`: the config values from section 0.1, plus pure fee and referral calculators with unit tests.
- Auth.js credentials login with argon2id password hashes and email verification.
- Secure password reset: a single-use hashed token sent to the verified email, a 30-minute TTL, all sessions revoked after reset, and no admin path that sets a password.
- An append-only, hash-chained audit log writer, used by every auth event.
- An owner role, and a minimal `/admin` page that is reachable only by the owner.
- A GitHub Actions workflow that runs typecheck, lint, tests, and build.
