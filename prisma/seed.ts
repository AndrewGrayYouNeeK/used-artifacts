import "dotenv/config";
import { createDb } from "@/lib/db";
import type { Vertical } from "@/generated/prisma/enums";

const db = createDb(process.env.DATABASE_URL!);

interface CategorySeed {
  slug: string;
  name: string;
  vertical: Vertical;
  isNativeAmerican?: boolean;
  requiresEnhancedReview?: boolean;
  children?: Omit<CategorySeed, "vertical" | "children">[];
}

// Artifacts are live for the beta; antiques are seeded but hidden until
// ENABLED_VERTICALS includes ANTIQUE (after grading launches).
const CATEGORIES: CategorySeed[] = [
  {
    slug: "native-american-artifacts",
    name: "Native American Artifacts",
    vertical: "ARTIFACT",
    isNativeAmerican: true,
    requiresEnhancedReview: true,
    children: [
      { slug: "stone-tools", name: "Stone Tools & Projectile Points" },
      { slug: "pottery", name: "Pottery & Sherds" },
      { slug: "textiles-basketry", name: "Textiles & Basketry" },
      { slug: "beadwork-jewelry", name: "Beadwork & Jewelry" },
    ],
  },
  {
    slug: "historic-artifacts",
    name: "Historic Artifacts",
    vertical: "ARTIFACT",
    children: [
      { slug: "bottles-glass", name: "Bottles & Glass" },
      { slug: "coins-tokens", name: "Coins & Tokens" },
      { slug: "tools-hardware", name: "Tools & Hardware" },
      { slug: "historic-jewelry", name: "Jewelry & Adornment" },
    ],
  },
  {
    slug: "world-artifacts",
    name: "World Artifacts",
    vertical: "ARTIFACT",
    requiresEnhancedReview: true,
    children: [
      { slug: "world-pottery", name: "Pottery & Ceramics" },
      { slug: "world-textiles", name: "Textiles" },
      { slug: "world-stone-tools", name: "Stone Tools" },
    ],
  },
  {
    slug: "antique-furniture",
    name: "Furniture",
    vertical: "ANTIQUE",
    children: [
      { slug: "antique-seating", name: "Seating" },
      { slug: "antique-case-pieces", name: "Case Pieces" },
    ],
  },
  {
    slug: "antique-decorative-arts",
    name: "Decorative Arts",
    vertical: "ANTIQUE",
    children: [
      { slug: "antique-silver", name: "Silver" },
      { slug: "antique-glass-ceramics", name: "Glass & Ceramics" },
      { slug: "antique-textiles", name: "Quilts & Textiles" },
      { slug: "antique-jewelry", name: "Jewelry" },
    ],
  },
];

const BADGES = [
  {
    code: "BETA_FOUNDER",
    name: "Beta Founder",
    kind: "COSMETIC" as const,
    description: "One of the first 100 sellers. Cosmetic only: no effect on fees or ranking.",
    criteria: { firstNSellers: 100 },
  },
  {
    code: "FIRST_SALE",
    name: "First Sale",
    kind: "VOLUME" as const,
    description: "Completed a first released sale.",
    criteria: { releasedSalesCount: 1 },
  },
  {
    code: "ESTABLISHED_SELLER",
    name: "Established Seller",
    kind: "VOLUME" as const,
    description: "10 released sales.",
    criteria: { releasedSalesCount: 10 },
  },
  {
    code: "TRUSTED_DEALER",
    name: "Trusted Dealer",
    kind: "VOLUME" as const,
    description: "50 released sales.",
    criteria: { releasedSalesCount: 50 },
  },
  {
    code: "COLLECTOR",
    name: "Collector",
    kind: "VOLUME" as const,
    description: "10 completed purchases.",
    criteria: { releasedPurchasesCount: 10 },
  },
];

const PROHIBITED_TERMS = [
  { pattern: "human remains", reason: "NAGPRA: human remains are banned" },
  { pattern: "skull", reason: "Possible human remains" },
  { pattern: "burial", reason: "Possible funerary object" },
  { pattern: "grave goods", reason: "NAGPRA: funerary objects are banned" },
  { pattern: "funerary", reason: "NAGPRA: funerary objects are banned" },
  { pattern: "sacred", reason: "NAGPRA: sacred objects are banned" },
  { pattern: "ceremonial", reason: "Possible sacred object; needs review" },
  { pattern: "cultural patrimony", reason: "NAGPRA: cultural patrimony is banned" },
  { pattern: "national forest", reason: "ARPA: federal land" },
  { pattern: "blm land", reason: "ARPA: federal land" },
  { pattern: "indian[- ]made", reason: "IACA: unverified Indian-made claim", isRegex: true },
  { pattern: "native american made", reason: "IACA: unverified Native American-made claim" },
];

async function seedCategories() {
  let order = 0;
  for (const top of CATEGORIES) {
    const parent = await db.category.upsert({
      where: { slug: top.slug },
      update: {},
      create: {
        slug: top.slug,
        name: top.name,
        vertical: top.vertical,
        isNativeAmerican: top.isNativeAmerican ?? false,
        requiresEnhancedReview: top.requiresEnhancedReview ?? false,
        sortOrder: order++,
      },
    });
    let childOrder = 0;
    for (const child of top.children ?? []) {
      await db.category.upsert({
        where: { slug: child.slug },
        update: {},
        create: {
          slug: child.slug,
          name: child.name,
          vertical: top.vertical,
          parentId: parent.id,
          isNativeAmerican: top.isNativeAmerican ?? false,
          requiresEnhancedReview: top.requiresEnhancedReview ?? false,
          sortOrder: childOrder++,
        },
      });
    }
  }
}

async function main() {
  await seedCategories();

  for (const badge of BADGES) {
    await db.badge.upsert({ where: { code: badge.code }, update: {}, create: badge });
  }

  for (const term of PROHIBITED_TERMS) {
    await db.prohibitedTerm.upsert({
      where: { pattern: term.pattern },
      update: {},
      create: { pattern: term.pattern, reason: term.reason, isRegex: term.isRegex ?? false },
    });
  }

  await db.provenanceStatementTemplate.upsert({
    where: { version: 1 },
    update: {},
    create: {
      version: 1,
      effectiveAt: new Date(),
      approvedBy: null,
      body: [
        "DRAFT: PENDING COUNSEL REVIEW (see BUILD_PLAN.md L2, L3, L5, L6). Not for production use.",
        "I declare that this item was not removed from any national forest, other federal land, state land, or tribal land;",
        "that it is not human remains, a funerary object, a sacred object, or an object of cultural patrimony;",
        "and that I have not represented it as Indian-made or Native American-made without verification.",
      ].join("\n"),
    },
  });

  console.info("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
