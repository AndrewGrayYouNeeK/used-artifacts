# used-artifacts

Used Artifacts: a marketplace for buying and selling used artifacts, with ID-verified sellers, signed provenance statements, payment held until delivery, and the Beta Founder badge program.

The full plan, owner decisions, and roadmap are in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Stack

Next.js 16 (App Router, Cache Components) · TypeScript · Postgres 16 + Prisma 7 · Zod · argon2id · Vitest · Stripe Identity · Stripe Connect (Express) · S3/R2 photo storage (sharp) · Claude vision (photo analyzer) · EasyPost tracking · Postmark.

## Local setup

```bash
cp .env.example .env               # then fill in values
npm install                        # also runs `prisma generate`
npm run db:deploy                  # apply migrations
npm run db:seed                    # categories, badges, prohibited terms, provenance template (draft)
npm run dev                        # http://localhost:3000
```

Without `POSTMARK_SERVER_TOKEN`, dev prints every email (verification and reset links) to the server log.

### Identity verification in dev

With no `STRIPE_SECRET_KEY`, "Verify my identity" opens a simulated ID check at `/account/verify/dev` where you type the document details. Typing the same document number, country, and date of birth on a second account shows duplicate rejection; the same name and date of birth with a different number sends the account to staff review.

For real Stripe Identity, set `STRIPE_SECRET_KEY`, `STRIPE_IDENTITY_WEBHOOK_SECRET`, and `IDENTITY_FINGERPRINT_SECRET`, and point a Stripe webhook at `/api/webhooks/stripe-identity` (`identity.verification_session.*` events). Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe-identity`.

### Checkout and payouts in dev

With no `STRIPE_SECRET_KEY` (or `PAYMENTS_PROVIDER=fake`), payouts and checkout use a simulator. "Set up payouts" on `/sell` opens `/sell/payouts/dev`, and "Buy now" opens `/checkout/dev/<order>`, where you enter a US address and a simulated card id. Buying from the same browser the seller signed in on (shared device cookie), or with a card id or address the seller's account has used, trips the self-buy block; use a separate browser profile per test account. Escrow timers run from the "Run now" button on `/admin/orders`; in production Vercel Cron calls `/api/cron/escrow` every 15 minutes with `CRON_SECRET`.

Photos are stored in `.data/uploads` (re-encoded to WebP, metadata stripped). Production uses S3 or Cloudflare R2 (`STORAGE_DRIVER=s3`).

For real Stripe Connect, point a webhook (with "Listen to events on Connected accounts" enabled) at `/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `account.updated`, and `charge.dispute.created`, and set `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe --forward-to localhost:3000/api/webhooks/stripe`.

### Photo analyzer in dev

With no `ANTHROPIC_API_KEY`, "Get suggestions" on `/sell/new` and the analysis that runs on every submission use canned output (`src/domains/ai/fake-vision.ts`). Set `ANTHROPIC_API_KEY` (and optionally `AI_VISION_MODEL`) to call Claude. The guardrails in `src/domains/ai/guardrails.ts` run on every result either way.

### Assign the Proprietor badge (one time, ever)

Sign up and verify your email, then run:

```bash
PROPRIETOR_EMAIL=you@example.com npm run proprietor:assign
```

This promotes the account to OWNER and permanently assigns the Proprietor badge. Database triggers block any later reassignment, deletion, or demotion.

Signup is invite-only (`BETA_INVITE_REQUIRED=true`). On a fresh deploy, set `PROPRIETOR_EMAIL` first: that one email can sign up without an invite until the Proprietor badge is assigned. After that, issue invite codes from `/admin/beta`.

### Staff two-factor sign-in

The owner and moderators must sign in with an authenticator app to open `/admin` (`STAFF_TWO_FACTOR_REQUIRED=true`). The first visit to `/admin` sends you to `/account/security` to scan a QR code and save 10 recovery codes. If someone loses both their phone and their recovery codes, confirm who they are out of band, then run on the server:

```bash
RESET_EMAIL=person@example.com RESET_REASON="Confirmed by phone call on 2026-11-02" npm run two-factor:reset
```

## Checks

```bash
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=postgresql://... npm run test:integration   # wipes that database
npm run build
```

CI (`.github/workflows/ci.yml`) runs all of these against a Postgres 16 service.
