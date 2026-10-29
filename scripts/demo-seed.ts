import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { MemoryMailer } from "@/lib/email/mailer";
import { assignProprietor } from "@/domains/identity/proprietor";
import { FakeVisionProvider } from "@/domains/ai/fake-vision";
import { PROVENANCE_TEMPLATE_V2 } from "@/domains/compliance/provenance-template";
import { decideListingReview } from "@/domains/compliance/review";
import { submitListing } from "@/domains/listings/listings";
import { storePhotos, type ObjectStorage } from "@/domains/listings/photos";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { startCheckout } from "@/domains/orders/checkout";
import { confirmReceipt, markShipped } from "@/domains/orders/fulfillment";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { assignAuthentication, createAuthenticator, recordAuthenticationResult } from "@/domains/grading/authentication";
import { awardBetaFounder } from "@/domains/growth/badges";

const databaseUrl = process.env.DATABASE_URL ?? "";
const dbHost = (() => {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "";
  }
})();
// Demo accounts share one known password and the demo owner takes the permanent Proprietor badge,
// so this must never touch a hosted database.
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1"].includes(dbHost)) {
  console.error("demo:seed only runs against a local database (DATABASE_URL host localhost) outside production.");
  process.exit(1);
}

const db = createDb(databaseUrl);
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const root = process.env.LOCAL_STORAGE_DIR ?? ".data/uploads";
const storage: ObjectStorage = {
  async put(key, bytes) {
    const file = path.join(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  },
  async get() {
    return null;
  },
  async delete() {},
  publicUrl: (key) => `/api/files/${key}`,
} as ObjectStorage;

const DEMO_PASSWORD = "correct horse battery";

async function user(email: string, displayName: string, role: "USER" | "OWNER" | "MODERATOR" = "USER") {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({ data: { email, displayName, passwordHash: await hashPassword(DEMO_PASSWORD), emailVerifiedAt: new Date(), role } });
}

async function verify(userId: string, legalName: string) {
  if (await db.identityVerification.findUnique({ where: { userId } })) return;
  await db.identityVerification.create({
    data: {
      userId,
      provider: "fake",
      providerSessionId: `demo_${randomUUID()}`,
      status: "VERIFIED",
      verifiedAt: new Date(),
      legalName,
      documentFingerprintHash: randomUUID(),
      personFingerprintHash: randomUUID(),
    },
  });
}

/** A studio-style placeholder photo: a shaped object on a soft backdrop. */
async function photo(shape: "point" | "sherd" | "bottle" | "blade" | "pendant", bg: string, fg: string, seed: number) {
  const shapes: Record<typeof shape, string> = {
    point: `<polygon points="400,90 520,430 470,470 455,560 345,560 330,470 280,430" fill="${fg}"/>
            <polyline points="400,120 430,300 405,450" stroke="rgba(255,255,255,.25)" stroke-width="6" fill="none"/>`,
    blade: `<polygon points="400,70 500,250 480,560 320,560 300,250" fill="${fg}"/>
            <polyline points="400,100 410,330 395,540" stroke="rgba(0,0,0,.2)" stroke-width="5" fill="none"/>`,
    sherd: `<polygon points="220,200 560,170 610,420 430,560 200,470" fill="${fg}"/>
            ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="${240 + i * 55}" y1="210" x2="${270 + i * 55}" y2="330" stroke="rgba(0,0,0,.35)" stroke-width="7"/>`).join("")}`,
    bottle: `<rect x="355" y="90" width="90" height="120" rx="12" fill="${fg}"/>
             <path d="M330 210 Q300 260 300 330 L300 580 Q300 610 330 610 L470 610 Q500 610 500 580 L500 330 Q500 260 470 210 Z" fill="${fg}"/>
             <rect x="330" y="360" width="140" height="120" rx="8" fill="rgba(255,255,255,.18)"/>`,
    pendant: `<circle cx="400" cy="360" r="170" fill="${fg}"/><circle cx="400" cy="230" r="22" fill="${bg}"/>
              <circle cx="400" cy="380" r="90" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="10"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="700">
    <defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#fbf8f2"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>
    <rect width="800" height="700" fill="url(#g)"/>
    <ellipse cx="400" cy="610" rx="230" ry="28" fill="rgba(0,0,0,.12)"/>
    <g transform="rotate(${(seed % 5) * 4 - 8} 400 350)">${shapes[shape]}</g>
    ${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 197 + seed * 31) % 800}" cy="${(i * 113 + seed * 17) % 700}" r="1.5" fill="rgba(0,0,0,.08)"/>`).join("")}
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer());
}

async function main() {
  const andrew = await user("andrew@usedartifacts.test", "Andrew Gray");
  if (!(await db.proprietor.count())) await assignProprietor(db, andrew.email);
  const mod = await user("mod@usedartifacts.test", "Mo Reviewer", "MODERATOR");
  const jane = await user("seller@usedartifacts.test", "Jane Carter");
  const bea = await user("buyer@usedartifacts.test", "Bea Collector");
  await verify(jane.id, "Jane Carter");
  await verify(bea.id, "Beatrice Collector");

  let store = await db.storefront.findFirst({ where: { ownerUserId: jane.id } });
  if (!store) {
    store = await db.storefront.create({
      data: {
        name: "Bluegrass Relics",
        slug: "bluegrass-relics",
        ownerUserId: jane.id,
        stripeAccountId: `fake_acct_${randomUUID()}`,
        payoutsEnabled: true,
        members: { create: { userId: jane.id, role: "OWNER" } },
      },
    });
    await awardBetaFounder(db as never, jane.id).catch(() => false);
  }
  const cat = async (slug: string) => db.category.findUniqueOrThrow({ where: { slug } });

  const items = [
    { slug: "stone-tools", shape: "point", bg: "#d9cbb3", fg: "#6b5a49", title: "Adena stemmed point, Kentucky hornstone", price: 65_000, desc: "Classic Adena stemmed point in blue-gray Kentucky hornstone, 3 1/4 inches. Even percussion flaking, crisp edges, no repairs or restoration. Ex-collection of a Boone County family, catalog number in ink on the reverse.", region: "Ohio Valley, Kentucky", age: "Early Woodland, c. 800–300 BC", materials: "Kentucky hornstone", cond: "Excellent, no repairs" },
    { slug: "stone-tools", shape: "blade", bg: "#e2d6c2", fg: "#8a6f52", title: "Hopewell-style blade, Wyandotte chert", price: 42_000, desc: "Broad ovate blade in banded Wyandotte chert, 4 1/2 inches. Thin, well-balanced, with a slight tip ding visible in the second photo.", region: "Southern Indiana", age: "Middle Woodland", materials: "Wyandotte (Harrison County) chert", cond: "Very good, small tip ding" },
    { slug: "stone-tools", shape: "point", bg: "#e8dfcf", fg: "#a1866a", title: "Archaic side-notched point, Flint Ridge chalcedony", price: 18_500, desc: "Side-notched Archaic point in translucent Flint Ridge chalcedony with pink and cream banding. 2 1/8 inches, sharp notches, base lightly ground.", region: "Central Ohio", age: "Early to Middle Archaic", materials: "Flint Ridge chalcedony", cond: "Excellent" },
    { slug: "pottery", shape: "sherd", bg: "#ddd2c0", fg: "#8c6d55", title: "Shell-tempered rim sherd with incised lines", price: 12_000, desc: "Mississippian shell-tempered rim sherd with parallel incised decoration, about 3 x 2 1/2 inches. Old collection label on the interior.", region: "Lower Ohio River", age: "Mississippian, c. AD 1100–1400", materials: "Shell-tempered earthenware", cond: "Sherd, stable edges" },
    { slug: "bottles-glass", shape: "bottle", bg: "#e6e0d3", fg: "#a8611e", title: "1880s amber bitters bottle, embossed panels", price: 8_500, desc: "Square amber bitters bottle with embossed side panels and applied tooled lip. 9 1/2 inches. Light interior haze, no chips or cracks.", cond: "Light haze, no damage" },
    { slug: "historic-jewelry", shape: "pendant", bg: "#e4dccd", fg: "#b08d57", title: "Victorian brass locket pendant, engraved", price: 9_500, desc: "Round brass locket with hand-engraved floral border and original glass inserts, about 1 1/2 inches. Hinge and clasp work as they should.", cond: "Good, light wear" },
    { slug: "stone-tools", shape: "blade", bg: "#ddd3c3", fg: "#5f574d", title: "Fort Ancient triangular point, Ohio", price: 14_000, desc: "Small triangular Fort Ancient point in gray Upper Mercer chert, 1 3/8 inches. Fine pressure flaking, one ear slightly short.", region: "Southern Ohio", age: "Late Prehistoric, c. AD 1000–1650", materials: "Upper Mercer chert", cond: "Very good", awaitingReview: true },
  ] as const;

  const listingIds: string[] = [];
  for (const [i, it] of items.entries()) {
    const existing = await db.listing.findFirst({ where: { title: it.title } });
    if (existing) {
      listingIds.push(existing.id);
      continue;
    }
    const category = await cat(it.slug);
    const stored = await storePhotos(storage, [await photo(it.shape, it.bg, it.fg, i * 3 + 1), await photo(it.shape, it.bg, it.fg, i * 3 + 2)]);
    if (!stored.ok) throw new Error(stored.reason);
    const native = category.isNativeAmerican;
    const submitted = await submitListing(
      { db, vision: new FakeVisionProvider() },
      {
        userId: jane.id,
        photos: stored.photos,
        submission: {
          categoryId: category.id,
          title: it.title,
          description: it.desc,
          askingPrice: it.price,
          shipping: 800,
          sellerConditionGrade: it.cond,
          regionOfOrigin: "region" in it ? it.region : undefined,
          estimatedAge: "age" in it ? it.age : undefined,
          materials: "materials" in it ? it.materials : undefined,
          acquisitionSource: "PURCHASED",
          acquisitionState: native ? "KY" : undefined,
          acquisitionYearApprox: native ? 2004 : undefined,
          acquisitionDetails: "Purchased at the estate sale of a long-time Kentucky collector in 2004; collection records kept.",
          attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
          iacaAcknowledged: native,
          signedName: "Jane Carter",
        },
      },
    );
    if (!submitted.ok) throw new Error(`${it.title}: ${JSON.stringify(submitted)}`);
    listingIds.push(submitted.listingId);
    // Left in the compliance queue so the moderator login has something to review.
    if ("awaitingReview" in it) continue;
    const decided = await decideListingReview({ db }, { reviewerId: mod.id, reviewId: submitted.reviewId, decision: "APPROVE", notes: "Provenance reviewed." });
    if (!decided.ok) throw new Error(JSON.stringify(decided));
  }

  const mailer = new MemoryMailer();
  const gradingDeps = { db, mailer, appUrl };
  if ((await db.authenticator.count()) === 0) {
    const partner = await createAuthenticator(
      { db },
      { actorId: andrew.id, name: "Dana Flint", organization: "Ohio Valley Lithic Authentication", credentials: "30 years authenticating Eastern Woodlands lithics", specialtyCategoryIds: [], agreementSigned: true },
    );
    if (!partner.ok) throw new Error(partner.reason);
    const sent = await assignAuthentication(gradingDeps, { actorId: andrew.id, authenticatorId: partner.authenticatorId, listingId: listingIds[0] });
    if (!sent.ok) throw new Error(sent.reason);
    await recordAuthenticationResult(gradingDeps, { actorId: andrew.id, submissionId: sent.submissionId, outcome: "AUTHENTICATED", notes: "Patination and flaking consistent with an authentic Adena point." });
  }

  if ((await db.order.count()) === 0) {
    const deps = { db, payments: new FakePaymentsProvider(appUrl), appUrl, linkageSecret: process.env.LINKAGE_HASH_SECRET! };
    for (const [n, listingId] of [listingIds[4], listingIds[5]].entries()) {
      const checkout = await startCheckout(deps, { buyerUserId: bea.id, buyerEmail: bea.email, listingId });
      if (!checkout.ok) throw new Error(checkout.reason);
      const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
      await processPaymentEvent(
        deps,
        fakeCheckoutCompleted({
          checkoutSessionId: payment.checkoutSessionId,
          amountCents: payment.amountCents,
          taxCents: 0,
          shippingAddress: { name: "Bea Collector", line1: "12 Elm St", city: "Lexington", state: "KY", postalCode: "40507", country: "US" },
          paymentFingerprint: "card_demo_bea",
        }),
      );
      if (n === 0) {
        await markShipped(deps, { sellerUserId: jane.id, orderId: checkout.orderId, carrier: "USPS", trackingNumber: "9400111899223197428490" });
        await confirmReceipt(deps, { buyerUserId: bea.id, orderId: checkout.orderId });
      }
    }
  }
  console.info(JSON.stringify({ listings: listingIds, store: store.slug }));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
