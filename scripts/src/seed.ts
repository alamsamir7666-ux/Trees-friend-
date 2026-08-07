import { db } from "@workspace/db";
import {
  categoriesTable as categories,
  productsTable as products,
  productVariantsTable as productVariants,
  couponsTable as coupons,
} from "@workspace/db/schema";
import { eq, isNull } from "drizzle-orm";

/**
 * Seed data respects the real 4-level dependency chain:
 *   1. categories       (parentId = NULL)      -- top-level, e.g. "Fruit Trees"
 *   2. categories        (parentId = <L1 id>)   -- subcategory, e.g. "Mango"
 *   3. products          (categoryId -> L2 subcategory id)
 *   4. productVariants   (productId -> product id)
 *
 * Each stage's inserted rows are looked up by slug to build the id map
 * the next stage needs -- ids are serial/auto-generated, so we can't
 * hardcode them.
 */

const topLevelCategories = [
  { name: "Fruit Trees", slug: "fruit-trees", icon: "🍎", displayOrder: 1 },
  { name: "Flowering Trees", slug: "flowering-trees", icon: "🌸", displayOrder: 2 },
  { name: "Indoor Plants", slug: "indoor-plants", icon: "🪴", displayOrder: 3 },
  { name: "Succulents", slug: "succulents", icon: "🌵", displayOrder: 4 },
];

const subCategories = [
  { name: "Mango", slug: "mango", icon: "🥭", displayOrder: 1, parentSlug: "fruit-trees" },
  { name: "Guava", slug: "guava", icon: "🍈", displayOrder: 2, parentSlug: "fruit-trees" },
  { name: "Lemon", slug: "lemon", icon: "🍋", displayOrder: 3, parentSlug: "fruit-trees" },
  { name: "Bougainvillea", slug: "bougainvillea", icon: "🌺", displayOrder: 1, parentSlug: "flowering-trees" },
  { name: "Hibiscus", slug: "hibiscus", icon: "🌺", displayOrder: 2, parentSlug: "flowering-trees" },
  { name: "Snake Plant", slug: "snake-plant", icon: "🪴", displayOrder: 1, parentSlug: "indoor-plants" },
  { name: "Money Plant", slug: "money-plant", icon: "🌿", displayOrder: 2, parentSlug: "indoor-plants" },
  { name: "Echeveria", slug: "echeveria", icon: "🌵", displayOrder: 1, parentSlug: "succulents" },
];

const seedProducts = [
  {
    name: "Alphonso Mango",
    slug: "alphonso-mango",
    scientificName: "Mangifera indica 'Alphonso'",
    description:
      "A premium grafted mango variety prized for its rich, sweet flavor and smooth, fiber-free pulp. Fruits within 2-3 years when grafted.",
    subcategorySlug: "mango",
    sunlight: "full_sun",
    watering: "moderate",
    soilType: "well-drained loamy soil",
    matureHeight: "15-20 ft",
    climateZone: "Zone 9-11",
    growthRate: "moderate",
    bloomSeason: "Spring",
    keyBenefits: ["Early fruiting when grafted", "Disease resistant", "High yield"],
    bestFor: ["Backyard orchards", "Large gardens"],
    careTips: ["Water deeply once a week", "Prune after fruiting season", "Feed with balanced fertilizer in spring"],
    images: ["https://images.unsplash.com/photo-1553279768-865429fa0078?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Seed Packet", variantType: "form", form: "seed", price: "150", stock: 200, deliveryCharge: "60" },
      { name: "Grafted Sapling - 2ft", variantType: "form", form: "sapling", price: "850", stock: 60, deliveryCharge: "150" },
      { name: "Potted - Mature", variantType: "form", form: "potted", price: "3200", stock: 15, deliveryCharge: "400" },
    ],
  },
  {
    name: "Thai Guava",
    slug: "thai-guava",
    scientificName: "Psidium guajava",
    description:
      "A dwarf, fast-growing guava variety that produces large, crisp, low-seed fruit. Well suited to containers and small yards.",
    subcategorySlug: "guava",
    sunlight: "full_sun",
    watering: "moderate",
    soilType: "sandy loam",
    matureHeight: "6-10 ft",
    climateZone: "Zone 9-11",
    growthRate: "fast",
    bloomSeason: "Year-round",
    keyBenefits: ["Fruits within 1 year", "Compact size", "Container-friendly"],
    bestFor: ["Balcony", "Small gardens"],
    careTips: ["Water when top inch of soil is dry", "Prune to control height", "Mulch to retain moisture"],
    images: ["https://images.unsplash.com/photo-1536511132770-e5058c7e8c46?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Sapling - 1.5ft", variantType: "form", form: "sapling", price: "450", stock: 80, deliveryCharge: "120" },
      { name: "Potted - Mature", variantType: "form", form: "potted", price: "1800", stock: 20, deliveryCharge: "300" },
    ],
  },
  {
    name: "Kaffir Lime",
    slug: "kaffir-lime",
    scientificName: "Citrus hystrix",
    description:
      "An aromatic citrus tree grown for its distinctively bumpy, fragrant leaves and fruit, widely used in cooking.",
    subcategorySlug: "lemon",
    sunlight: "full_sun",
    watering: "moderate",
    soilType: "well-drained loamy soil",
    matureHeight: "8-12 ft",
    climateZone: "Zone 9-11",
    growthRate: "slow",
    bloomSeason: "Spring",
    keyBenefits: ["Fragrant leaves for cooking", "Compact growth", "Hardy citrus variety"],
    bestFor: ["Kitchen gardens", "Containers"],
    careTips: ["Water moderately, avoid waterlogging", "Feed with citrus fertilizer every 6-8 weeks"],
    images: ["https://images.unsplash.com/photo-1591196611258-c7e2a26e6c2b?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Sapling - 1ft", variantType: "form", form: "sapling", price: "350", stock: 100, deliveryCharge: "100" },
    ],
  },
  {
    name: "Bougainvillea Glabra",
    slug: "bougainvillea-glabra",
    scientificName: "Bougainvillea glabra",
    description:
      "A vigorous, thorny climbing shrub known for its vivid papery bracts. Thrives in heat and tolerates poor soil.",
    subcategorySlug: "bougainvillea",
    sunlight: "full_sun",
    watering: "low",
    soilType: "well-drained, tolerates poor soil",
    matureHeight: "10-15 ft (trained)",
    climateZone: "Zone 9-11",
    growthRate: "fast",
    bloomSeason: "Year-round in warm climates",
    keyBenefits: ["Drought tolerant", "Vivid, long-lasting color", "Low maintenance once established"],
    bestFor: ["Fences", "Trellises", "Privacy screens"],
    careTips: ["Water sparingly once established", "Prune to shape after each bloom cycle"],
    images: ["https://images.unsplash.com/photo-1597305877032-0668b3c6413a?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Potted - 1ft", variantType: "form", form: "potted", price: "280", stock: 120, deliveryCharge: "90" },
    ],
  },
  {
    name: "Snake Plant Laurentii",
    slug: "snake-plant-laurentii",
    scientificName: "Dracaena trifasciata 'Laurentii'",
    description:
      "A hardy, air-purifying indoor plant with striking yellow-edged upright leaves. Extremely tolerant of low light and infrequent watering.",
    subcategorySlug: "snake-plant",
    sunlight: "partial_shade",
    watering: "low",
    soilType: "well-draining cactus/succulent mix",
    matureHeight: "2-3 ft",
    climateZone: "Indoor, Zone 9-11 outdoor",
    growthRate: "slow",
    bloomSeason: "Rare indoors",
    keyBenefits: ["Air purifying", "Tolerates neglect", "Low light tolerant"],
    bestFor: ["Bedrooms", "Offices", "Low-light corners"],
    careTips: ["Water only when soil is fully dry", "Avoid overwatering, root rot is the main risk"],
    images: ["https://images.unsplash.com/photo-1593482892290-f54927ae1bb6?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Potted - Small", variantType: "size", form: "potted", price: "320", stock: 150, deliveryCharge: "80" },
      { name: "Potted - Large", variantType: "size", form: "potted", price: "750", stock: 40, deliveryCharge: "150" },
    ],
  },
  {
    name: "Golden Pothos",
    slug: "golden-pothos",
    scientificName: "Epipremnum aureum",
    description:
      "A trailing vine with heart-shaped, variegated leaves. One of the easiest houseplants to grow, tolerant of a wide range of conditions.",
    subcategorySlug: "money-plant",
    sunlight: "partial_shade",
    watering: "moderate",
    soilType: "standard potting mix",
    matureHeight: "Trailing, up to 6 ft",
    climateZone: "Indoor",
    growthRate: "fast",
    bloomSeason: "Rarely flowers indoors",
    keyBenefits: ["Beginner friendly", "Fast growing", "Propagates easily in water"],
    bestFor: ["Hanging baskets", "Shelves", "Water propagation"],
    careTips: ["Water when top soil is dry", "Wipe leaves occasionally to keep them dust-free"],
    images: ["https://images.unsplash.com/photo-1600411833196-7c1f6b1eb9b7?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Potted - Small", variantType: "size", form: "potted", price: "180", stock: 200, deliveryCharge: "70" },
    ],
  },
  {
    name: "Echeveria Elegans",
    slug: "echeveria-elegans",
    scientificName: "Echeveria elegans",
    description:
      "A rosette-forming succulent with pale blue-green leaves, often called Mexican Snowball. Compact and ideal for sunny windowsills.",
    subcategorySlug: "echeveria",
    sunlight: "full_sun",
    watering: "low",
    soilType: "cactus/succulent mix",
    matureHeight: "3-6 in",
    climateZone: "Zone 9-11, indoor elsewhere",
    growthRate: "slow",
    bloomSeason: "Summer",
    keyBenefits: ["Drought tolerant", "Compact rosette form", "Easy to propagate from leaves"],
    bestFor: ["Windowsills", "Succulent arrangements"],
    careTips: ["Water deeply then let soil dry fully", "Ensure bright light to keep rosette compact"],
    images: ["https://images.unsplash.com/photo-1509423350716-97f9360b4e09?w=600&q=90"],
    productStatus: "in_stock",
    variants: [
      { name: "Potted - Single", variantType: "form", form: "potted", price: "220", stock: 180, deliveryCharge: "70" },
    ],
  },
];

const sampleCoupons = [
  {
    code: "WELCOME20",
    discountType: "percentage",
    discountValue: "20",
    minOrderAmount: "1000",
    expiryDate: new Date("2026-12-31"),
    isActive: true,
  },
  {
    code: "GREEN500",
    discountType: "fixed",
    discountValue: "500",
    minOrderAmount: "3000",
    expiryDate: new Date("2026-12-31"),
    isActive: true,
  },
];

async function seed() {
  console.log("Seeding database...");

  // --- Stage 1: top-level categories ---
  const existingTopLevel = await db.select().from(categories).where(isNull(categories.parentId));
  if (existingTopLevel.length === 0) {
    await db.insert(categories).values(topLevelCategories);
    console.log(`Inserted ${topLevelCategories.length} top-level categories`);
  } else {
    for (const cat of topLevelCategories) {
      try {
        await db.insert(categories).values(cat).onConflictDoNothing();
      } catch (_) {}
    }
    console.log("Top-level categories seeded (skipped existing)");
  }

  const allTopLevel = await db.select().from(categories).where(isNull(categories.parentId));
  const topLevelIdBySlug = new Map(allTopLevel.map((c) => [c.slug, c.id]));

  // --- Stage 2: subcategories (need parent ids from stage 1) ---
  const existingSub = await db.select().from(categories).where(eq(categories.slug, subCategories[0].slug));
  if (existingSub.length === 0) {
    const subRows = subCategories.map(({ parentSlug, ...rest }) => ({
      ...rest,
      parentId: topLevelIdBySlug.get(parentSlug)!,
    }));
    await db.insert(categories).values(subRows);
    console.log(`Inserted ${subRows.length} subcategories`);
  } else {
    console.log("Subcategories already exist, skipping");
  }

  const allCategories = await db.select().from(categories);
  const subcategoryIdBySlug = new Map(allCategories.filter((c) => c.parentId !== null).map((c) => [c.slug, c.id]));

  // --- Stage 3: products (need subcategory ids from stage 2) ---
  const existingProducts = await db.select().from(products);
  let insertedProducts: { id: number; slug: string }[] = [];
  if (existingProducts.length === 0) {
    for (const p of seedProducts) {
      const { subcategorySlug, variants, ...productFields } = p;
      const categoryId = subcategoryIdBySlug.get(subcategorySlug);
      if (!categoryId) {
        console.warn(`Skipping "${p.name}": subcategory "${subcategorySlug}" not found`);
        continue;
      }
      const [inserted] = await db
        .insert(products)
        .values({ ...productFields, categoryId })
        .returning({ id: products.id, slug: products.slug });
      insertedProducts.push(inserted);
    }
    console.log(`Inserted ${insertedProducts.length} products`);
  } else {
    console.log(`Products already exist (${existingProducts.length}), skipping`);
  }

  // --- Stage 4: product variants (need product ids from stage 3) ---
  if (insertedProducts.length > 0) {
    const productIdBySlug = new Map(insertedProducts.map((p) => [p.slug, p.id]));
    let variantCount = 0;
    for (const p of seedProducts) {
      const productId = productIdBySlug.get(p.slug);
      if (!productId) continue;
      for (const v of p.variants) {
        await db.insert(productVariants).values({ ...v, productId });
        variantCount++;
      }
    }
    console.log(`Inserted ${variantCount} product variants`);
  }

  // --- Coupons ---
  const existingCoupons = await db.select().from(coupons);
  if (existingCoupons.length === 0) {
    await db.insert(coupons).values(sampleCoupons);
    console.log(`Inserted ${sampleCoupons.length} coupons`);
  } else {
    console.log("Coupons already exist, skipping");
  }

  console.log("Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
