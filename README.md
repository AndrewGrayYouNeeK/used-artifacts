# used-artifacts

Used Artifacts: a marketplace for buying and selling used artifacts, with ID-verified sellers, signed provenance statements, payment held until delivery, and the Beta Founder badge program.

The full plan, owner decisions, and roadmap are in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Stack

Next.js 16 (App Router, Cache Components) · TypeScript · Postgres 16 + Prisma 7 · Zod · argon2id · Vitest. Stripe Connect, Stripe Identity, and Postmark arrive in later phases.

## Local setup

```bash
cp .env.example .env               # then fill in values
npm install                        # also runs `prisma generate`
npm run db:deploy                  # apply migrations
npm run db:seed                    # categories, badges, tiers, provenance template draft
npm run dev                        # http://localhost:3000
```

Without `POSTMARK_SERVER_TOKEN`, dev prints every email (verification and reset links) to the server log.

### Assign the Proprietor badge (one time, ever)

Sign up and verify your email, then run:

```bash
PROPRIETOR_EMAIL=you@example.com npm run proprietor:assign
```

This promotes the account to OWNER and permanently assigns the Proprietor badge. Database triggers block any later reassignment, deletion, or demotion.

## Checks

```bash
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=postgresql://... npm run test:integration   # wipes that database
npm run build
```

CI (`.github/workflows/ci.yml`) runs all of these against a Postgres 16 service.
