# Used Artifacts — Build Plan

Status: **APPROVED by Andrew (2026-10-22).** Owner decisions are recorded in section 0. Phase 0 is done; Phase 1 (identity and compliance core) is built, see section 11. This plan covers the stack, the data model, the architecture, phased milestones mapped to the 11 roadmap sections, third-party services, and open legal questions.

---

## 0. Owner decisions (2026-10-22)

| # | Decision |
|---|---|
| B1 | **Multi-tenant** means each seller gets their own storefront under the Used Artifacts brand. White-label sub-marketplaces are out of scope. |
| B2 | **Referral payout: a flat 5% of the SALE PRICE on every sale by a recruit, first sale included**, for as long as the recruit sells (it never ends). It is paid out of the platform's take and capped so a payout never exceeds the fees collected on that sale. *(Revised 2026-10-22: the earlier 10% first-sale rate was dropped.)* Which amount "the sale" means under the two-sided fees is open; see 0.2. |
| B3 | **Two-sided 10% fees, no paid tier (final, 2026-10-22).** Membership is free for everyone. The seller sets an **asking price**. The **buyer price shown online is asking + 10%**, and checkout never adds a fee on top of the shown price. The **seller payout is asking − 10%**. The platform keeps both fees, about 20% of asking. *(Replaces the earlier $20/month paid tier, which is removed entirely.)* |
| B4 | **Buyers need ID verification only to bid or sell.** Browsing and fixed-price buying do not require it. |
| B5 | A cosmetic **"Beta Founder" badge** is allowed for the **first 100 sellers**. It has no effect on fees or ranking and is kept separate from volume badges. |
| B10 | A unique **"Proprietor" badge** for Andrew, the platform owner. It has premium, top-tier styling and is distinct from Beta Founder. It cannot be earned or bought, and code and the database enforce that **exactly one user can ever hold it**. It is shown on his owner dashboard profile and everywhere he appears (storefront, listings, bids, comments). See section 4.6a. |
| B6 | **Scope (corrected 2026-10-22): artifacts first, antiques later.** The long-term definition includes antiques, but the **first beta is artifacts only**. Antiques open once grading exists. Every category carries a `vertical` (`ARTIFACT` or `ANTIQUE`), and the `ENABLED_VERTICALS` config value controls which verticals are visible and listable, so antiques can be switched on later without a migration. Native American and archaeological categories keep the enhanced review rules. |
| B9 | **Grading is staged (roadmap item 11, revised).** Grading Stage 1 runs during the beta: 1–2 private partner authenticators for high-value pieces, results shown as listing badges, and sales-outcome data collected. Grading Stage 2 starts once patterns emerge: in-house rubrics, with partner verification before any grade goes public. See section 6.2. *The brand comes from accuracy, not from having a lab on day one.* |
| B7 | **US-only shipping** at launch. |
| B8 | **3-day hold after delivery** before auto-release. **48-hour payment window** for auction winners. |
| — | Unchanged: auctions stay off until the Kentucky licensing question (L1) is answered, The full in-house grading program and the MUSEUM_GRADE tier still come last. |

### 0.1 Configuration values

All of these numbers are config values, not hard-coded. In Phase 0 they live in `src/config/economics.ts` and can be overridden through environment variables. A later phase moves them to an owner-editable, audited settings table.

| Key | Default | Meaning |
|---|---|---|
| `BUYER_FEE_BPS` | 1000 (10%) | Buyer fee, built into the shown price: buyer price = asking + this |
| `SELLER_FEE_BPS` | 1000 (10%) | Seller fee, deducted from the asking price: payout = asking − this |
| `REFERRAL_BPS` | 500 (5% of the sale) | Referrer's share of every sale by the recruit, first sale included, with no end date |
| `REFERRAL_BASIS` | `BUYER_PRICE`, pending Andrew | Which amount the referral percentage applies to: `BUYER_PRICE` (what the buyer paid) or `ASKING_PRICE` |
| `REFERRAL_CAP_AT_PLATFORM_FEE` | `true` | If true, a referral payout can never exceed the fees the platform actually collected on that order (see 0.2) |
| `ESCROW_AUTO_RELEASE_DAYS` | 3 | Days after carrier-confirmed delivery before funds auto-release |
| `AUCTION_PAYMENT_WINDOW_HOURS` | 48 | Time an auction winner has to pay |
| `ENABLED_VERTICALS` | `ARTIFACT` | Comma-separated list of verticals open for listing and browsing. Add `ANTIQUE` once grading exists. |
| `HIGH_VALUE_THRESHOLD_CENTS` | 50000 ($500), placeholder | Asking price at or above which a listing is eligible for partner authentication in Grading Stage 1. Andrew sets the real number. |

(bps = basis points; 100 bps = 1%.)

### 0.2 Fee and referral economics

Fees are computed in integer cents with half-up rounding per fee (`src/domains/pricing/pricing.ts`). The same pure function drives the listing form preview, checkout, and the order snapshot, so the seller sees exactly what will happen. Each order stores its own asking price, both fee rates and amounts, the buyer price, and the payout, and database CHECK constraints enforce `buyerPrice = asking + buyerFee`, `payout = asking − sellerFee`, and `platformFee = buyerFee + sellerFee`.

On a **$100 asking price**, before Stripe processing fees:

| Seller | Buyer pays | Seller receives | Platform take | Referral (5%) | **Platform nets** |
|---|---|---|---|---|---|
| Not referred | $110.00 | $90.00 | $20.00 | – | **$20.00** |
| Referred, `REFERRAL_BASIS=BUYER_PRICE` (default) | $110.00 | $90.00 | $20.00 | $5.50 | **$14.50** |
| Referred, `REFERRAL_BASIS=ASKING_PRICE` | $110.00 | $90.00 | $20.00 | $5.00 | **$15.00** |

- **Open question for Andrew: what is "the sale" for the 5% referral?** The default is the buyer price ($110, so $5.50), since that is what was actually sold for. The alternative is the asking price ($100, so $5.00). It is one config value.
- **Stripe processing fees** (about 2.9% + 30¢ per card charge, on the $110 charged) come to about $3.49 here. Unless they are passed on, they come out of the platform take: roughly $16.51 net when not referred and $11.01 when referred (buyer-price basis).
- **Shipping and sales tax** are separate lines at checkout (marketplace-facilitator tax is required by law in most states). "No fee on top of the shown price" holds for platform fees; Andrew should confirm that showing shipping and tax separately is acceptable.
- **Cap:** `REFERRAL_CAP_AT_PLATFORM_FEE=true` keeps any payout from exceeding the fees collected on that sale. With today's defaults the referral is about a quarter of the take, so the cap only matters if rates change.
- Since referrals never end, the referral liability grows with every referred seller. The ledger tracks it in a separate `referral_payable` account so it is visible on the GM dashboard.

### 0.3 Supabase note

The plan uses its own database-backed sessions (see the Auth row in section 2), not Supabase Auth, and Phase 0 is built that way. Supabase may still host Postgres. **If Supabase Auth is ever adopted**, Andrew must set the **Site URL** and the **redirect allow-list** by hand in the Supabase dashboard under **Authentication > URL configuration**. Otherwise verification and password-reset links will point to the wrong host or be rejected.

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
| Auth | **In-house email + password auth with database sessions** (changed from Auth.js during Phase 0). Passkeys/TOTP later | We need full control over the password-reset flow (roadmap item 10), so a hosted provider that lets admins set passwords is a poor fit. Auth.js's credentials provider only supports stateless JWT sessions, which can't be revoked, but a password reset must sign out every device. So the session cookie holds a random token, and only its SHA-256 hash is stored in `Session`. Passwords are hashed with argon2id. |
| Background jobs | **pg-boss** (Postgres-backed queue) on a long-running worker. Alternative: Inngest | Auction closes, payment-window expiries, escrow auto-release timers, fraud scans, and AI jobs all need durable, exactly-once-ish scheduling. Keeping the queue in Postgres means no extra infrastructure. |
| Realtime (auctions) | **Server-Sent Events** from the worker/app, fanned out via Postgres `LISTEN/NOTIFY`. Upgrade path: Ably or Pusher | Live bid updates without managing WebSocket infrastructure at beta scale. |
| File storage | **Cloudflare R2** or **S3**, with signed uploads | Listing photos, provenance documents, and grading images. Private bucket for ID and provenance documents. |
| Image processing | **sharp** plus perceptual hashing (pHash/dHash) | Thumbnails, EXIF stripping (privacy: removes GPS), and duplicate-image detection, which feeds self-reselling and circle-trade detection. |
| AI vision | **Provider-agnostic adapter** over OpenAI / Anthropic / Google vision models | Roadmap item 8 says to use existing APIs. The adapter lets us swap providers and A/B test them. Output must be structured JSON validated with Zod. |
| Email | **Postmark** (or Resend) | Transactional email is critical here: verification and password-reset links. Postmark has a strong deliverability record. |
| Hosting | **Vercel** for the Next.js app, plus **Render/Fly.io** for the worker process | Vercel is fine for request/response work. Auction timers need an always-on worker. |
| Observability | **Sentry** (errors), **PostHog** (product analytics and feature flags), structured logs | PostHog flags gate auctions and the grading module. |
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
- `growth`: referrals, badges.
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

- The charge goes to the platform. The seller's share is a **Transfer** created on release, using `source_transaction` to link it to the charge. The charge is the buyer price (asking + buyer fee) plus shipping and tax; the transfer is the seller payout (asking − seller fee) plus shipping. The platform retains both fees; the referral share is carved out of them (roadmap item 6).
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
- **Listing**: `id, storefrontId, sellerUserId, categoryId, title, description, condition, format (FIXED|AUCTION), askingPriceCents?, status (DRAFT|PENDING_REVIEW|LIVE|SOLD|REMOVED), publishedAt`. Buyers only ever see `askingPriceCents + buyer fee`.
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

- **Order**: `id, listingId, buyerUserId, sellerUserId, storefrontId, source (FIXED|AUCTION|SECOND_CHANCE), askingPriceCents, buyerFeeBps, buyerFeeCents, buyerPriceCents, sellerFeeBps, sellerFeeCents, sellerPayoutCents, platformFeeCents, shippingCents, taxCents, status (state machine above), paymentDueAt, deliveredAt, releaseEligibleAt`
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

### 4.6 Growth: referrals, badges

- Membership is free for everyone and there is no paid tier (B3), so there are no membership or subscription tables.
- **Referral**: `id, referrerUserId, refereeUserId (unique), code, createdAt, firstSaleOrderId?`
- **ReferralEarning**: `referralId, orderId (unique per referral), rateBps, basis (BUYER_PRICE|ASKING_PRICE, snapshotted from config), basisCents, platformFeeCents (both fees), cappedAtFee (bool), amountCents, status (PENDING|PAYABLE|PAID|CLAWED_BACK)`. `amountCents = basisCents × rateBps`, capped at `platformFeeCents` when `REFERRAL_CAP_AT_PLATFORM_FEE` is on. It becomes PAYABLE only when the order reaches `RELEASED`/`AUTO_RELEASED`, and it is clawed back on refund.
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
| **0** | Foundations | 1 (skeleton), 10 (audit, auth) | Repo scaffold, CI, DB, email + password auth with database sessions and email verification, **secure password reset**, `AuditEvent` writer, owner role, deploys to staging. |
| **1** | Identity and compliance core | 2 | Stripe Identity flow, one-identity uniqueness, provenance statement templates and signing, prohibited-item rules, compliance review queue, account-linkage signals collected at login and checkout. |
| **2** | Storefronts, listings, fixed-price checkout with escrow | 1, 4 | Storefront onboarding (Stripe Connect Express), listing CRUD with photos, search and browse, checkout, the order state machine, shipping and tracking, buyer confirmation and auto-release, disputes, ledger, self-buy block. |
| **3** | AI photo analyzer | 8 | Vision adapter, analysis job, guardrail post-processor, seller accept/reject UI, auto-routing of flagged items to compliance. |
| **4** | Owner GM dashboard v1 | 10 | Users, storefronts, listings, orders, disputes, compliance queue, fraud signals, enforcement, audit-log viewer, "send reset email" (never "set password"), metrics. |
| **5** | Badges and referrals | 7, 6 | Volume-only badges computed from released orders. Referral codes, earnings from the platform fee, clawbacks, payouts via Stripe transfers, fraud freezes. |
| **6** | Auctions (behind a flag) | 3 | Auction engine, proxy bids, soft close, no-reserve rules, retraction limits, payment window and relist/second chance, shill detection and penalties. **Not enabled in production until legal question L1 is resolved.** |
| **7** | **Closed beta** | 9 | Invite-only (invite codes issued by the owner), small trusted group, feedback channel, compliance review on 100% of listings, daily fraud review, kill switches. |
| **8** | *(Removed: there is no paid tier.)* | 5 | Roadmap item 5 is satisfied by the free membership base. Seller analytics, if wanted, ship free. |
| **9** | Circle-trade detection hardening and public launch readiness | 2, 10 | Graph job tuned on beta data, appeal flows, load testing auctions, counsel sign-off on all legal templates. |
| **7a** | **Grading Stage 1 (during beta)** | 11 | 1–2 private partner authenticators onboarded. Owner-assigned authentication of high-value pieces (at or above `HIGH_VALUE_THRESHOLD_CENTS`). AUTHENTICATED results shown as listing badges. `ListingOutcome`, `ListingDailyStat`, and `ListingPriceChange` populated, with a basic "what sells" report on the GM dashboard. |
| **10** | Grading Stage 2 and the full grading arm | 11 | Starts **once patterns emerge** in the Stage 1 data. In-house condition rubrics per category (textiles, pottery, stone tools, jewelry). Andrew's grades go to `PENDING_VERIFICATION`, and the same partner authenticators verify them before they go public. Accuracy (agreement-rate) dashboard. Per-item grading fees. After that: the MUSEUM_GRADE tier, the public verify page, and **opening the ANTIQUE vertical** via `ENABLED_VERTICALS`. |

Notes:

- The beta runs **with auctions off unless L1 is cleared**, so it tests the risky core (compliance, escrow, fraud).
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

**Behind a flag / out:** auctions (pending L1), circle-trade graph detection (signals are collected; reviewers act on them manually during beta), the antiques vertical, in-house rubric grading (Stage 2), and MUSEUM_GRADE.

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
- **B2. Referral math.** *(Answered: a flat 5% of the sale price on every sale, capped at the fee. See section 0.)* Is it "10% / 5% **of the platform fee**" (proposed: the referrer earns 10% of the 10% fee on the first sale, i.e. 1% of the sale, then 5% of the fee) or "10% / 5% **of the sale price**" (which would consume the platform's entire fee on the first sale)? Does "ongoing" last forever or have a cap (for example 12 months)? When a paid tier lowers the fee, is the referral computed on the reduced fee? (Proposed: yes, on the fee actually collected.)
- **B3.** *(Answered: 10% from each side, no paid tier. See section 0.)* Platform fee is 10% for the free tier. What fee rate and price should each paid tier have?
- **B4.** Must buyers be ID-verified to purchase at fixed price, or only to bid and sell?
- **B5.** The README mentions a "founders badge program". Is a non-volume "Founder/Beta" badge allowed, given roadmap item 7 (badges for real volume only)? Proposed: a cosmetic "Beta Founder" label kept separate from volume badges, with no fee or ranking effect.
- **B6.** What scope is "used artifacts": only archaeological and cultural artifacts, or also general antiques and collectibles? This changes category trees, review load, and how much legal exposure we carry.
- **B7.** Is shipping US-only at launch? (Proposed: yes.)
- **B8.** Auto-release window after delivery (proposed 3 days) and the auction payment window (proposed 48 hours).

---

## 10. Phase 0 scope (done)

Built on the same branch and PR as this plan:

- Next.js (App Router) + TypeScript scaffold, with ESLint and Vitest.
- Prisma schema for all entities above, grading included, with an initial migration.
- `src/config/economics.ts`: the config values from section 0.1, plus pure fee and referral calculators with unit tests.
- Email + password login with argon2id hashes, revocable database sessions, and email verification. Verification and reset links open a page with a confirm button, so email link scanners can't use up the single-use token.
- Secure password reset: a single-use hashed token sent to the verified email, a 30-minute TTL, all sessions revoked after reset, and no admin path that sets a password.
- An append-only, hash-chained audit log writer, used by every auth event.
- An owner role, and a minimal `/admin` page that is reachable only by the owner. It shows the owner's profile with the Proprietor badge.
- The Proprietor singleton table and its triggers, the `proprietor:assign` script, and the `<UserIdentity>` component.
- `ENABLED_VERTICALS` and the category `vertical` field, with the artifact category tree seeded.
- A GitHub Actions workflow that runs typecheck, lint, tests, and build.

## 11. Phase 1: identity verification and provenance (built)

Roadmap item 2. Auctions stay disabled (`AUCTIONS_ENABLED=false`).

**Identity (Stripe Identity, required to sell or bid; not to browse or buy at fixed price, B4)**
- Consent notice (biometric, draft pending lawyer review) and checkbox before any session starts; consent version and time are stored. Each user gets at most 5 paid attempts.
- Stripe session: government ID (license, passport, ID card), live capture, matching selfie. Results arrive by signed webhook (`/api/webhooks/stripe-identity`); every event id is stored so retries are processed once.
- We store the status, legal name, birth year, document type and country. We never store ID images, the selfie, or the document number.
- **One identity per account:** a keyed HMAC of country + document number + date of birth is a unique column. A document already on another account is `DUPLICATE_REJECTED`, the two accounts are linked (`SAME_ID_HASH_ATTEMPT`), and a fraud signal is raised. Concurrent attempts are serialized per fingerprint, so two accounts racing with one ID can't both pass.
- **Same person, different document:** a second keyed HMAC of normalized legal name + full date of birth. A match with another account puts the verification in `NEEDS_REVIEW` (linked as `SAME_PERSON_DETAILS`) for staff to approve or reject with notes. Nobody can review their own.
- `checkIdentityGate(userId, "SELL" | "BID")` guards storefront creation and listing submission; `BID` also requires `AUCTIONS_ENABLED`.
- Dev and tests use a simulated provider; production refuses it.

**Sworn provenance statement (template v2, marked "DRAFT – PENDING LAWYER REVIEW")**
- Six attestations: not from national forest, park, BLM, other federal, state or local public, or tribal land (ARPA); lawful private-land finds with permission; not human remains, funerary or sacred objects, or cultural patrimony, and not from a grave or burial (NAGPRA); no unverified Indian-made claim (IACA); legal title; truthfulness and penalties.
- All attestations are required, plus acquisition source, details, and (for private land) the landowner's name and state. The typed signature must match the verified legal name.
- The statement stores a frozen snapshot of the listing and a SHA-256 signature hash over template, snapshot, answers, signer, and time. The database refuses edits or deletes of statements and edits of template wording (new wording = new version). A template can only stop being a draft when an approver is recorded.

**Native American artifact rules**
- Categories flagged Native American require region of origin, estimated age, materials, acquisition state and year, and acknowledgement of the IACA disclosure, which is also shown on the public listing.
- Screening runs on all listing text. **Blocked outright** (no listing is created, and the attempt is audited): human remains, funerary objects and grave goods, items from graves, burials or mounds, sacred objects, medicine bundles, cultural patrimony, Indian-made / Native American-made claims, and eagle parts (Bald and Golden Eagle Protection Act). **Flagged for review:** ceremonial, effigy, kachina/katsina, burial, bone, skull, mentions of federal, state or tribal land, and excavation wording. The baseline list lives in code and is seeded into `ProhibitedTerm`; staff can add terms or tighten one to BLOCK, but never loosen a baseline block.

**Compliance review (100% of beta listings)**
- Every submission is `PENDING_REVIEW` with a `ComplianceReview` (reason KEYWORD, CATEGORY, or BETA_FULL_REVIEW, plus flags). Staff approve (LIVE) or reject (with notes shown to the seller) at `/admin/compliance`. Sellers can't review their own listings.
- The database refuses to set a listing LIVE unless it has a signed statement from the seller and the seller is currently `VERIFIED`.

**Pricing in the listing form:** the seller enters the asking price and sees the buyer price (asking + 10%) and their payout (asking − 10%) live. Public pages show only the buyer price.

**Audit events:** `identity.verification_started`, `.processing`, `.requires_input`, `.canceled`, `.verified`, `.needs_review`, `.duplicate_rejected`, `.review_approved`, `.review_rejected`, `.webhook_unknown_session`, `fraud.signal_created`, `storefront.created`, `listing.submitted`, `listing.submission_blocked`, `provenance.signed`, `compliance.review_opened`, `compliance.listing_approved`, `compliance.listing_rejected`.

**Needs Andrew's decision or action**
1. **Referral basis:** "5% of the sale" on the buyer price ($5.50 per $100 asking, the default) or the asking price ($5.00)? (`REFERRAL_BASIS`, section 0.2.)
2. **Shipping and sales tax** shown separately at checkout. Is that consistent with "no fee on top of the shown price"?
3. **Stripe processing fees** (about $3.49 on a $110 charge) currently come out of the platform's take.
4. **Stripe Identity setup:** a restricted key with sensitive verification-result access (Stripe must approve it, because duplicate detection needs the document number), the webhook endpoint and secret, and `IDENTITY_FINGERPRINT_SECRET`. Stripe bills per verification; the 5-attempt cap limits cost.
5. **Lawyer review** of the provenance wording, the consent notice (BIPA and similar state laws, L11), and the IACA disclosure. Approved wording ships as template v3 with `approvedBy` set.
6. **Self-review:** a seller can't approve their own listing, so Andrew's own listings need a second staff account (a MODERATOR).
7. **Pre-1979 acquisitions:** ARPA covers removals after October 31, 1979. Should older acquisitions get different treatment or documentation (L2)?
8. **Landowner permission documents:** the schema has `landownerPermissionDocKey`; uploads arrive with photo storage in Phase 2. Should they be mandatory for private-land finds?
9. **Screening list:** review the BLOCK vs REVIEW split in `src/domains/compliance/prohibited-terms.ts` with counsel.

## 12. Phase 2: storefronts, listings, checkout with held funds (built)

Roadmap items 1 and 4. Auctions stay off.

**Storefronts and payouts**
- A storefront connects a Stripe Connect **Express** account (Stripe collects bank, KYC, and 1099-K tax details). Buyers can't purchase until `payoutsEnabled` is true; `account.updated` webhooks keep it current.

**Listings**
- 1–8 photos per listing, up to 5 MB each. The browser downscales to 1600 px; the server re-encodes to WebP (max 2000 px), strips EXIF/GPS metadata, and stores them in S3/R2 (local disk in dev).
- Each photo gets a 64-bit difference hash (`ItemFingerprint`). A photo matching (Hamming distance ≤ 6) one used by the seller or a linked account is flagged for the reviewer; a match owned by another seller also raises a `SELF_RESALE` fraud signal.
- Shipping is a flat seller-set US price (B7), shown separately. Sellers can change the asking price (history kept in `ListingPriceChange` for grading data) or withdraw. Editing text means withdraw and resubmit, so the signed provenance snapshot always matches what's shown.
- `/browse` searches titles, descriptions, materials, and regions across enabled verticals only (antiques stay hidden). Listing views are counted in `ListingDailyStat`.

**Checkout and held funds (separate charges and transfers)**
- "Buy now" creates an order with a **fee snapshot** (asking, buyer fee, seller fee, buyer price, payout) and a Stripe Checkout Session for buyer price + shipping (+ tax if enabled). No fee is added at checkout. The listing is reserved for `CHECKOUT_HOLD_MINUTES`; one active order per listing is enforced by a partial unique index.
- On payment the money is recorded in an **append-only double-entry ledger** (database triggers refuse edits and deletes): cash → buyer_held. On release: buyer_held → seller_payable (payout + shipping), platform_revenue (both fees), tax_payable. A Stripe transfer (idempotency key `order:<id>:release`, linked to the charge with `source_transaction`) then pays the seller; failures retry from the cron job.
- **State machine** (section 3.3) is enforced twice: in code and by an `order_status_guard` trigger listing the same edges, with a test that keeps them identical.
- **Release:** the buyer confirms receipt, or 3 days after carrier-confirmed delivery (`ESCROW_AUTO_RELEASE_DAYS`) the cron job auto-releases. Auto-release requires a delivery record (DB CHECK) and no fraud hold. Without EasyPost, staff mark delivery from the carrier's site at `/admin/orders`.
- **Timers** (`/api/cron/escrow`, every 15 minutes): expire unpaid checkouts, refund orders not shipped within `SELLER_SHIP_BY_DAYS` (5), auto-release, retry transfers and refunds (max 10 attempts, then visible to staff).
- **Disputes:** the buyer can report a problem until release; funds stay held. Staff (never a party to the order) resolve with notes: release, full refund, or partial refund. Chargebacks open a dispute automatically.
- **Self-buy block:** before checkout and again after payment, the buyer is checked against the seller, storefront members, and strong links (same ID hash, device cookie, card fingerprint, shipping address). Pre-checkout hits are refused; post-payment hits put the order on a fraud hold for staff. Card fingerprints and addresses are stored only as keyed hashes.
- A seller can cancel a paid, unshipped order (full refund). A refunded item goes back on sale, unless it was refunded through a dispute.

**Owner tools:** `/admin/orders` shows ledger balances (held, owed to sellers, platform revenue, referrals, tax), open disputes, fraud holds, in-transit orders, and recent orders.

**Audit events:** `storefront.payout_account_created`, `storefront.payouts_updated`, `order.created`, `order.self_buy_blocked`, `order.paid`, `order.hold_placed`, `order.hold_cleared`, `order.shipped`, `order.delivered`, `order.released`, `order.refunded` (seller cancel, missed ship-by, dispute), `order.expired`, `order.late_payment_refunded`, `order.dispute_opened`, `order.dispute_resolved`, `order.chargeback_opened`, `order.chargeback_after_release`, `payment.transfer_paid`, `payment.refund_succeeded`, `payment.unknown_checkout`, `listing.price_changed`, `listing.withdrawn`, `trust.account_linked`, `fraud.signal_created`. Failed transfers and refunds keep the last error on the row for staff.

**Needs Andrew's decision or action**
1. **Partial refunds** come out of the seller's share; the platform keeps both fees. Alternative: refund fees proportionally.
2. **Sales tax** is off (`STRIPE_AUTOMATIC_TAX=false`) until Stripe Tax registrations exist (L10). Turning it on adds tax at checkout as a separate line.
3. **Stripe processing fees** (about 2.9% + 30¢) come out of the platform's 20% take.
4. **Delivery confirmation without EasyPost** is a manual staff step. Add `EASYPOST_API_KEY` and `EASYPOST_WEBHOOK_SECRET` to automate it.
5. **Stripe Connect setup:** enable Connect (Express) on the platform account, set the branding, create the webhook endpoint (platform and connected-account events), and add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LINKAGE_HASH_SECRET`, and `CRON_SECRET` as secrets. Confirm with Stripe that holding funds until delivery is allowed for our account (L4); the "buyer protection hold" wording is used in the UI pending counsel.
6. **Photo storage:** create an R2 (or S3) bucket with a public CDN domain and add the `S3_*` and `STORAGE_PUBLIC_BASE_URL` secrets.

## 13. Phase 3: AI photo analyzer (built)

Roadmap item 8.

**Pipeline**
- Photos are re-encoded and stripped of metadata (Phase 2), then sent to a vision adapter (`VisionProvider`; Claude via the Messages API, forced to answer through one tool call with a JSON schema). Dev and tests use a simulator; production refuses it.
- The output is validated with Zod and post-processed by **deterministic guardrail code** (`src/domains/ai/guardrails.ts`) before anyone sees it. Each `AiAnalysis` stores the raw output, normalized output, provider, model, prompt version, flags, and the guardrail actions applied. The database refuses edits and deletes of the output; only the listing link, photo ids, and seller decisions can be filled in, once.
- **Every submission is analyzed**, so the analyzer can't be skipped. A seller can also run "Get suggestions" before submitting (30 runs per day). That run is reused at submission when it covered the same photos. If the seller changed the category since, the guardrails are re-applied to the stored output for the new category, with no new model call.
- A provider outage or invalid output never blocks the seller. The analysis is recorded as unavailable (HIGH uncertainty) and staff review the listing as usual.

**Guardrails (code, not just the prompt)**
- **Native American attribution:** a Native American category (selected or suggested), or any mention of a tribe, "Indian", "Native American", "indigenous", "tribal", or an archaeological culture (Adena, Hopewell, Mississippian, Archaic, Woodland, Clovis…) forces `uncertainty = HIGH` and attaches the IACA disclosure.
- **Maker claims stripped:** "Indian-made", "Navajo-made", "made by the Cherokee", "authentic Native American jewelry" and similar are rewritten to "style/attribution unverified".
- **No authentication or grading:** grading or authentication fields in the output are dropped, and "authenticated", "certified", "museum-grade", "is authentic" and similar are rewritten to "unverified". The analyzer has no path to the grading tables.
- **Ranges, never point estimates:** the value range is widened to a minimum spread for its uncertainty (1.25× LOW, 1.5× MEDIUM, 2× HIGH). Uncertainty is never lowered below the model's, and LOW becomes MEDIUM when the identification confidence is under 50%.
- **Red flags:** possible human remains, funerary objects, sacred or ceremonial objects, cultural patrimony, and protected wildlife parts **hold the listing for compliance** (review reason `AI_FLAG`). A reviewer can only approve with written notes (20+ characters), and the approval is audited. Possible reproductions are flagged without the hold. The model's cleaned wording is also run through the compliance screening list; a block-level hit (e.g. "human bone") holds the listing too.
- Unknown categories and unknown red-flag codes from the model are dropped, never trusted.

**Seller and staff views**
- The listing form shows the suggestions (category, title, materials, age, region) with "Use" buttons, an uncertainty badge, the identification with confidence, the value range ("not an appraisal"), observations, red flags, the IACA disclosure when attributed, and a notice that AI suggestions aren't authentication, grading, or appraisal. The seller's accepted and rejected suggestions are recorded.
- The compliance queue shows each listing's photos, reused-photo matches, and the analysis (uncertainty, red flags, screening matches, flags, guardrail actions, model and prompt version, seller decisions).
- The AI value range and uncertainty feed `ListingOutcome` for the Grading Stage 1 data.

**Audit events:** `ai.analysis_recorded`.

**Needs Andrew's decision or action**
1. **Vision provider and key:** add `ANTHROPIC_API_KEY` as a secret. Request zero data retention from Anthropic for seller photos (L11), or tell us to switch providers; the adapter is one file.
2. **Model choice:** `AI_VISION_MODEL` defaults to `claude-sonnet-4-5`. Pick the model you want to pay for; each analysis sends up to 8 photos.
3. **Daily suggestion quota:** 30 runs per seller per day (`DAILY_SUGGESTION_LIMIT`). Submissions are always analyzed.
4. **Over-triggering is deliberate:** words like "Archaic", "Woodland", or tribe names that are also common words ("Creek", "Crow") force HIGH uncertainty. Tell us if that's too noisy once real data arrives.

## 14. Phase 4: owner GM dashboard (built)

Roadmap item 10.

**Pages** (`/admin/*`, with a shared nav; moderators see everything except the overview and the audit log)
- **Overview (owner):** the Proprietor card, audit hash-chain status, queue shortcuts (compliance, trust and safety, orders), marketplace health (GMV and platform fees for 30 days and all time, platform revenue from the ledger, held funds, 90-day dispute rate, users, verified sellers, payout-ready storefronts, live/sold/removed listings, compliance approval rate and median hours to decision, AI red-flag rate, suspended and banned accounts, open fraud signals by detector), the **"what sells" report** (sell-through, median days to sell, average sale and ask by category, from `ListingOutcome`; this is the Grading Stage 1 report), and the fee economics.
- **Users:** search by email, name, storefront, or ID, and filter by status and role. Each user page shows identity-check status, badges, storefront, listings, purchases and sales, open fraud signals, linked accounts, recent sign-in attempts, enforcement history, and audit events about and by the account. Staff can only **send the standard reset email**; no page sets or shows a password.
- **Listings:** browse by status with a one-step "remove listing" (a recorded enforcement action).
- **Trust and safety:** open fraud signals (highest score first) with the accounts involved and the evidence, confirm or dismiss with notes, and restricted accounts.
- **Audit log (owner):** filter by action prefix, subject, and actor, page backwards through history, and expand any event to see its before and after snapshots, actor, IP hash, and hash. Chain verification runs in batches, so it scales.

**Enforcement** (`src/domains/admin/enforcement.ts`)
- Warning, remove a listing, revoke a badge, suspend (1 to 365 days), ban. Each is stored permanently (the database refuses deletes and edits; an action can only be lifted, once, with a reason), audited, and **emailed to the user with the reason and how to appeal**.
- Suspend and ban are **owner-only and need the owner's password again**. Suspension signs the user out, blocks sign-in, and hides their storefront and listings from browse. A ban also removes their live and pending listings (except ones with an order in progress), closes the storefront, and supersedes any open suspension.
- Suspensions end automatically (`/api/cron/escrow` also runs `liftExpiredSuspensions`). Staff can lift any action on appeal; badges are restored, removed listings stay removed (the seller can resubmit).
- Taking action from a fraud signal confirms it. Signals can also be confirmed or dismissed with notes.
- The owner account can never be restricted (a database trigger refuses it), and staff can't act on themselves.
- **Roles:** only the owner makes or removes moderators, with the password again. OWNER is never granted here (the Proprietor is assigned once, by script).

**Audit events:** `enforcement.issued`, `enforcement.lifted`, `enforcement.expired`, `fraud.signal_confirmed`, `fraud.signal_dismissed`, `user.role_changed`.

**Not in this phase:** owner two-factor sign-in (TOTP), required by section 8, ships with the closed-beta hardening in Phase 7. Until then, sensitive owner actions are protected by password re-entry.

## 15. Phase 5: badges and referrals (built)

Roadmap items 6 and 7.

**Referrals** (`src/domains/growth/referrals.ts`)
- Every account gets a share code and link on **Account → Referrals** (`/signup?ref=CODE`). Signing up through the link shows "Invited by …" and records a permanent `Referral`; the database refuses edits and deletes. Unknown codes are ignored.
- When a recruit's sale is **released** (buyer confirmation, auto-release, or a dispute resolved in the seller's favor), the referrer earns **5% of the buyer price** (`REFERRAL_BASIS`, still pending Andrew), capped at the fees collected on that order. A partial refund lowers the basis. The ledger moves the amount from `platform_revenue` to `referral_payable:<referrer>`, so it comes out of the platform's take, never the seller's.
- Earnings wait **30 days** (`REFERRAL_HOLD_DAYS`, the chargeback window), then become payable. The scheduled job pays each referrer by Stripe transfer from the platform balance once they have **$10** ready (`REFERRAL_MIN_PAYOUT_CENTS`). Payouts need an active account, **a verified ID** (section 5.2), and a Stripe payout account (the same one sellers set up).
- **Fraud freezes:** an earning is frozen (and a `REFERRAL_ABUSE` fraud signal raised) when the referrer bought the item, the buyer is linked to the referrer, or the recruit is linked to the referrer (likely the same person). Staff release or forfeit it from Trust and safety. A forfeit reverses it in the ledger, records a `FEE_FORFEIT` action, and emails the referrer.
- **Clawbacks:** a chargeback after release, or banning the referrer, reverses any unpaid earnings. The database only allows these status moves: pending → payable, frozen, or clawed back; frozen → pending, payable, or clawed back; payable → paid, frozen, or clawed back. Paid and clawed back are final, and amounts never change.

**Badges** (`src/domains/growth/badges.ts`)
- **Volume badges** (First Sale, Established Seller at 10 sales, Trusted Dealer at 50, Collector at 10 purchases; thresholds live in each badge's `criteria`) are recounted for both parties on every release, on a chargeback after release, and when staff confirm a fraud signal on an order. Only clean sales count: released, no chargeback, no open or confirmed fraud signal on the order, the other party isn't a linked account, and at most 3 orders with the same person (`BADGE_MAX_SALES_PER_COUNTERPARTY`). A badge is revoked automatically if the count drops below its threshold.
- A badge revoked by staff stays revoked until the revocation is lifted on appeal. Badge awards can't be deleted, so history is kept.
- **Beta Founder** goes to each of the first 100 sellers when their first listing is approved (`BETA_FOUNDER_LIMIT`). The database also refuses more awards than the badge's `firstNSellers`, counting revoked ones.
- The badges are created by the migration, so every environment has them. The Proprietor badge is separate and untouched by this code.

**Staff tools:** frozen earnings on Trust and safety, referral details on each user page, and "referral earnings owed" on the overview.

**Audit events:** `referral.created`, `referral.earning_accrued`, `referral.earnings_payable`, `referral.earning_unfrozen`, `referral.earning_clawed_back`, `referral.payout_paid`, `referral.payout_cancelled`, `badge.awarded`, `badge.revoked`.

**Needs Andrew's decision or action**
1. **Referral basis** is still the open question from section 0.2: buyer price ($5.50 per $100 asking, the current default) or asking price ($5.00).
2. **Payout timing:** the 30-day hold and $10 minimum are proposals. Shorter holds pay sooner but risk paying on sales that are later charged back.
3. **Referrers who don't sell** have to set up a Stripe payout account through the selling flow to get paid. Tell us if you'd rather offer a payouts-only setup.
4. **Counsel (L7):** the referral disclosure on the referrals page is marked DRAFT – PENDING LAWYER REVIEW (FTC endorsement wording and 1099 reporting).
5. **Badge names and thresholds** are the seeded ones; change them any time in the `Badge` table.

## 16. Phase 6: auctions (built, flag OFF)

Roadmap item 3. Everything here is behind `AUCTIONS_ENABLED`, which stays **false** in every environment until counsel answers L1 (Kentucky auctioneer licensing). With the flag off, the listing form shows no auction option, the server refuses auction submissions and approvals (`AUCTIONS_DISABLED`), browse shows only fixed-price items, bidding is refused, and the auction jobs do nothing.

**Format and pricing**
- The seller picks fixed price or auction. An auction has a starting bid, an optional reserve (no reserve = `isNoReserve`, enforced by a DB CHECK), and a 3, 5, 7, or 10-day duration. The seller enters asking-price terms; bidders see buyer-price terms (asking + 10%), so the "no fee on top" rule holds. At close the winning price is split back: asking = price ÷ 1.10 (rounded down), buyer fee = the rest, seller fee = 10% of asking.
- The auction starts when compliance approves the listing; rejection, withdrawal, staff removal, or a ban cancels it. Price changes are refused for auctions, and withdrawal is refused once bids exist.

**Bidding**
- **Proxy bids:** each bidder enters a maximum; the current price is the second-highest maximum plus one increment (eBay-style table, 50¢ under $10 up to $250 over $5,000), capped at the leader's maximum. Ties go to the earlier bid. When a maximum reaches the reserve, the price jumps to the reserve.
- **Soft close:** a bid in the final 2 minutes (`AUCTION_SOFT_CLOSE_MINUTES`) extends the end to 2 minutes after that bid.
- Bidders need a verified ID (`BID` gate). The seller, storefront members, and strongly linked accounts can't bid (`SELF_DEALING`, which also raises a shill signal). Bids are locked per auction (`SELECT … FOR UPDATE`) and the database refuses edits and deletes of bids.
- Outbid bidders get an email. The listing page refreshes every 15 seconds (polling, not live push).
- The public view shows aliases ("Bidder 1"), never the reserve amount or anyone's maximum.

**Retractions**
- A **typo** (the new maximum is at least 10× the price before it) is retracted immediately. "Description changed" and "seller unreachable" go to staff on Trust and safety. Nothing can be retracted in the final 12 hours, except a typo within a minute of placing it. Limit: 1 per 90 days (a pending request counts); 3 approved in a year raises a `RETRACTION_ABUSE` signal.

**Close, payment, non-payment**
- At the end the auction is **sold** (an order with the fee snapshot, payable within `AUCTION_PAYMENT_WINDOW_HOURS`) or **unsold** (no bids, or reserve not met). The winner pays from the listing or order page; payment goes into the same held-funds flow as fixed-price orders (Phase 2), and the auction becomes settled.
- An unpaid winner gets a **non-paying bidder strike**. Two strikes in a year block bidding. The seller then has 3 days (`AUCTION_SELLER_DECISION_DAYS`) to offer a **second chance** to the next eligible bidder at that bidder's maximum, or **relist**; after that it relists automatically.

**Shill detection**
- Each bid is scored: weak link to the seller (+40), 70% or more of the bidder's 5+ recent bids on this seller (+30), bidding on 3+ of the seller's closed auctions without winning (+20), 2+ retractions (+10). At 50 a `SHILL` signal is raised; at 80 the bidder's bids are voided automatically. Staff can void bids from the signal, which records a `BID_VOID` enforcement action. The price is recomputed after any void.

**Database guards:** one open auction per listing (partial unique index), CHECKs on auction terms and bid amounts, an auction status trigger (scheduled → live → ended/unsold → settled or awaiting seller → relisted; finished auctions are immutable), and append-only bids, retractions, and strikes.

**Audit events:** `auction.bid_placed`, `auction.self_bid_blocked`, `auction.closed_sold`, `auction.closed_unsold`, `auction.winner_did_not_pay`, `auction.second_chance_offered`, `auction.relisted`, `auction.bid_retracted`, `auction.retraction_requested`, `auction.retraction_approved`, `auction.retraction_denied`, `auction.bids_voided`, `fraud.signal_created`. Auction start and cancellation are covered by the compliance and listing events that trigger them.

**Needs Andrew's decision or action**
1. **L1 (counsel):** whether hosting timed online auctions needs a Kentucky auctioneer license (KRS 330) or other state licenses. The flag stays off until then.
2. **L8 (counsel):** enforceability of strikes, bid voiding, and fee forfeiture in the Terms of Service.
3. **Auction parameters:** the increment table, the 2-minute soft close, 2 strikes per year, 1 retraction per 90 days, second-chance price (the runner-up's maximum), and automatic relisting after 3 days are proposals.
4. **Live updates:** the listing refreshes every 15 seconds. Tell us if you want live push before auctions turn on.
