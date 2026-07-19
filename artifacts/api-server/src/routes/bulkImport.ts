import { Router } from "express";
import { db } from "@workspace/db";
import { productsTable, productVariantsTable, categoriesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { eq, or } from "drizzle-orm";
import crypto from "crypto";

const router = Router();

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseList(val: string): string[] {
  if (!val) return [];
  return val.split("|").map(s => s.trim()).filter(Boolean);
}

/**
 * POST /api/admin/products/bulk-import
 * Body: { csv: string } — raw CSV text
 * Headers: name,subcategory,variantform,variantname,price,discountprice,stock,deliverycharge,description,images,keybenefits,bestfor,caretips,scientificname,sunlight,watering,soiltype,matureheight,climatezone,bloomseason
 *
 * subcategory: matched against an existing subcategory by NAME or SLUG (case-insensitive)
 * variantform: one of seed | sapling | grafted | potted (defaults to "sapling")
 * variantname: display name for the variant this row creates (defaults to the form label)
 *
 * Multi-value fields use | as separator:
 *   keybenefits: "Fast fruiting|Drought tolerant"
 *   bestfor: "Home gardens|Balcony pots"
 *   caretips: "Water weekly|Prune after fruiting"
 *   images: "https://url1.jpg|https://url2.jpg"
 *
 * GROUPING RULE: rows are grouped by (name, subcategory) case-insensitively.
 * All rows in a group become VARIANTS of a single product — e.g. three rows
 * named "Himsagar Mango" with forms seed/grafted/potted create ONE product
 * with THREE variants, not three separate products. This matches how the
 * Edit Product form works (one product, many variants).
 *
 * If a product with the same name already exists under that subcategory
 * (from a previous import or manual creation), new rows are added to it as
 * additional variants instead of creating a duplicate product. Product-level
 * fields (description, scientificName, care info, etc.) are taken from the
 * first row of each group and are NOT used to overwrite an existing product
 * — only new variants are appended to it.
 */
router.post("/admin/products/bulk-import", requireAdmin, async (req: any, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") {
      res.status(400).json({ error: "CSV content is required" });
      return;
    }

    const lines = csv.split("\n").map((l: string) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      return;
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const nameIdx = headers.indexOf("name");
    const subcategoryIdx = headers.indexOf("subcategory");
    const priceIdx = headers.indexOf("price");

    if (nameIdx === -1 || subcategoryIdx === -1 || priceIdx === -1) {
      res.status(400).json({ error: "CSV must have columns: name, subcategory, price (minimum)" });
      return;
    }

    const variantFormIdx = headers.indexOf("variantform");
    const variantNameIdx = headers.indexOf("variantname");
    const discountPriceIdx = headers.indexOf("discountprice");
    const stockIdx = headers.indexOf("stock");
    const deliveryChargeIdx = headers.indexOf("deliverycharge");
    const descIdx = headers.indexOf("description");
    const imagesIdx = headers.indexOf("images");
    const keyBenefitsIdx = headers.indexOf("keybenefits");
    const bestForIdx = headers.indexOf("bestfor");
    const careTipsIdx = headers.indexOf("caretips");
    const scientificNameIdx = headers.indexOf("scientificname");
    const sunlightIdx = headers.indexOf("sunlight");
    const wateringIdx = headers.indexOf("watering");
    const soilTypeIdx = headers.indexOf("soiltype");
    const matureHeightIdx = headers.indexOf("matureheight");
    const climateZoneIdx = headers.indexOf("climatezone");
    const bloomSeasonIdx = headers.indexOf("bloomseason");

    // Pre-load all subcategories (only rows with a parentId are valid targets)
    const allCategories = await db.select().from(categoriesTable);
    const subcategories = allCategories.filter((c) => c.parentId != null);
    function findSubcategory(nameOrSlug: string) {
      const needle = nameOrSlug.trim().toLowerCase();
      return subcategories.find(
        (c) => c.name.toLowerCase() === needle || c.slug.toLowerCase() === needle
      );
    }

    const FORM_LABELS: Record<string, string> = { seed: "Seed", sapling: "Sapling", grafted: "Grafted", potted: "Potted" };
    const VALID_FORMS = new Set(Object.keys(FORM_LABELS));

    type ParsedRow = {
      rowNum: number;
      name: string;
      subcategoryId: number;
      price: number;
      discountPrice: number | null;
      stock: number;
      deliveryCharge: number;
      variantForm: string;
      variantName: string;
      description: string;
      images: string[];
      keyBenefits: string[];
      bestFor: string[];
      careTips: string[];
      scientificName: string;
      sunlight: string;
      watering: string;
      soilType: string;
      matureHeight: string;
      climateZone: string;
      bloomSeason: string;
    };

    const errors: string[] = [];
    const parsedRows: ParsedRow[] = [];

    // --- Pass 1: validate and parse every row individually ---
    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCsvLine(lines[i]);
      const name = cols[nameIdx]?.trim();
      const price = parseFloat(cols[priceIdx]);
      const subcategoryRaw = cols[subcategoryIdx]?.trim();

      if (!name || isNaN(price) || price <= 0) {
        errors.push(`Row ${rowNum}: invalid name or price`);
        continue;
      }
      if (!subcategoryRaw) {
        errors.push(`Row ${rowNum}: subcategory is required`);
        continue;
      }
      const subcategory = findSubcategory(subcategoryRaw);
      if (!subcategory) {
        errors.push(`Row ${rowNum}: subcategory "${subcategoryRaw}" not found — create it first in the Categories tab`);
        continue;
      }

      const discountPriceRaw = discountPriceIdx >= 0 && cols[discountPriceIdx]
        ? parseFloat(cols[discountPriceIdx]) : null;
      if (discountPriceRaw != null && !isNaN(discountPriceRaw) && discountPriceRaw >= price) {
        errors.push(`Row ${rowNum}: discountprice (${discountPriceRaw}) must be less than price (${price})`);
        continue;
      }

      const stockRaw = stockIdx >= 0 ? parseInt(cols[stockIdx] ?? "0") : 0;
      const deliveryChargeRaw = deliveryChargeIdx >= 0 ? parseFloat(cols[deliveryChargeIdx] ?? "0") : 0;

      let variantForm = (variantFormIdx >= 0 ? cols[variantFormIdx]?.trim().toLowerCase() : "") || "sapling";
      if (!VALID_FORMS.has(variantForm)) {
        errors.push(`Row ${rowNum}: variantform "${variantForm}" is invalid — must be one of seed, sapling, grafted, potted`);
        continue;
      }
      const variantName = (variantNameIdx >= 0 ? cols[variantNameIdx]?.trim() : "") || FORM_LABELS[variantForm];

      parsedRows.push({
        rowNum,
        name,
        subcategoryId: subcategory.id,
        price,
        discountPrice: discountPriceRaw != null && !isNaN(discountPriceRaw) ? discountPriceRaw : null,
        stock: isNaN(stockRaw) ? 0 : stockRaw,
        deliveryCharge: isNaN(deliveryChargeRaw) ? 0 : deliveryChargeRaw,
        variantForm,
        variantName,
        description: descIdx >= 0 ? (cols[descIdx] ?? "") : "",
        images: imagesIdx >= 0 ? parseList(cols[imagesIdx] ?? "") : [],
        keyBenefits: keyBenefitsIdx >= 0 ? parseList(cols[keyBenefitsIdx] ?? "") : [],
        bestFor: bestForIdx >= 0 ? parseList(cols[bestForIdx] ?? "") : [],
        careTips: careTipsIdx >= 0 ? parseList(cols[careTipsIdx] ?? "") : [],
        scientificName: scientificNameIdx >= 0 ? (cols[scientificNameIdx] ?? "") : "",
        sunlight: sunlightIdx >= 0 ? (cols[sunlightIdx] ?? "") : "",
        watering: wateringIdx >= 0 ? (cols[wateringIdx] ?? "") : "",
        soilType: soilTypeIdx >= 0 ? (cols[soilTypeIdx] ?? "") : "",
        matureHeight: matureHeightIdx >= 0 ? (cols[matureHeightIdx] ?? "") : "",
        climateZone: climateZoneIdx >= 0 ? (cols[climateZoneIdx] ?? "") : "",
        bloomSeason: bloomSeasonIdx >= 0 ? (cols[bloomSeasonIdx] ?? "") : "",
      });
    }

    // --- Pass 2: group valid rows by (name, subcategoryId), case-insensitive on name ---
    const groups = new Map<string, ParsedRow[]>();
    for (const row of parsedRows) {
      const key = `${row.name.toLowerCase()}::${row.subcategoryId}`;
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    // Pre-load existing products so re-imports merge into them instead of duplicating.
    const existingProducts = await db.select().from(productsTable);
    function findExistingProduct(name: string, categoryId: number) {
      const needle = name.trim().toLowerCase();
      return existingProducts.find(
        (p) => p.name.trim().toLowerCase() === needle && p.categoryId === categoryId
      );
    }

    let productsCreated = 0;
    let productsMerged = 0;
    let variantsCreated = 0;

    // --- Pass 3: for each group, create-or-reuse the product, then insert one variant per row ---
    for (const [, rows] of groups) {
      const first = rows[0];
      try {
        let productId: number;
        const existing = findExistingProduct(first.name, first.subcategoryId);

        if (existing) {
          productId = existing.id;
          productsMerged++;
        } else {
          const slug = first.name.toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "")
            + "-" + crypto.randomBytes(3).toString("hex");

          const [p] = await db.insert(productsTable).values({
            name: first.name,
            slug,
            categoryId: first.subcategoryId,
            scientificName: first.scientificName || null,
            description: first.description,
            sunlight: first.sunlight || null,
            watering: first.watering || null,
            soilType: first.soilType || null,
            matureHeight: first.matureHeight || null,
            climateZone: first.climateZone || null,
            bloomSeason: first.bloomSeason || null,
            images: first.images,
            keyBenefits: first.keyBenefits,
            bestFor: first.bestFor,
            careTips: first.careTips,
          }).returning({ id: productsTable.id });

          productId = p.id;
          productsCreated++;
          await logAudit({ adminId: req.userId, action: "product.created", targetType: "product", targetId: String(productId), after: { name: first.name } });
        }

        for (const row of rows) {
          await db.insert(productVariantsTable).values({
            productId,
            name: row.variantName,
            variantType: "form",
            form: row.variantForm,
            price: String(row.price),
            discountPrice: row.discountPrice != null ? String(row.discountPrice) : null,
            stock: row.stock,
            deliveryCharge: String(row.deliveryCharge),
          });
          variantsCreated++;
        }
      } catch (err: any) {
        for (const row of rows) {
          errors.push(`Row ${row.rowNum}: ${err.message ?? "Failed to insert"}`);
        }
      }
    }

    res.json({
      created: productsCreated,
      merged: productsMerged,
      variantsCreated,
      errors: errors.length,
      errorDetails: errors,
      message: `Imported ${productsCreated} new product(s), added variants to ${productsMerged} existing product(s), ${variantsCreated} variant(s) total`
        + (errors.length > 0 ? `, ${errors.length} row(s) failed` : ""),
    });
  } catch {
    res.status(500).json({ error: "Failed to process CSV import" });
  }
});

export default router;
