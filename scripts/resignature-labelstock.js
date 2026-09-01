import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import { buildLabelStockSignature, buildLabelStockSpecSignature } from "../utils/labelStockVariant.js";

// ---------------------------------------------------------------------------
// Re-signature every row behind /sachiko/label-stock/view
// (routes/sachiko/sachiko_route.js GET /label-stock/view -> SachikoLabelStock
// .find()), and report which rows share the same recipe.
//
// Two things, one pass:
//
//  1. RESYNC labelStockSignature -- the sha256 the create/edit dialog uses to
//     block an exact duplicate (buildLabelStockSignature, includes Product
//     Code). Recomputed here from each row's own stored data, so a row whose
//     signature is missing (created before the field existed) or stale (the
//     field list in utils/labelStockVariant.js changed since it was saved)
//     gets brought back in step. A row whose fresh signature would collide
//     with another row's is left untouched and reported -- that means two
//     rows are already byte-for-byte the same record and a human has to
//     merge/delete one; a script can't guess which.
//
//  2. LIST SAME-SPEC ROWS -- rows grouped by buildLabelStockSpecSignature
//     (every signature field EXCEPT Product Code -- the same "is this really
//     the same material recipe?" test resolveLabelStockProductCode /
//     findLabelStockSpecMatch use). Any group with more than one member is
//     printed in full: those rows are the same label stock under different
//     Product Codes (or SKU codes). Rows are normalized through the schema
//     first (fills in defaults like releaseLinerColor:"WHITE") so a legacy
//     row saved before a default existed still matches a newer identical one
//     -- exactly what utils/labelStockVariant.js's normalizeRecipe does.
//     Within a group, rows that also share the full labelStockSignature
//     (identical Product Code too) are flagged EXACT.
//
// Dry-run by default -- only step 1 writes anything, and only with --apply.
// Step 2 is read-only always.
//
//   node scripts/resignature-labelstock.js           # preview + report
//   node scripts/resignature-labelstock.js --apply    # commit signature resync
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

// Mirror utils/labelStockVariant.js normalizeRecipe: cast the stored row
// through the schema so defaults land, then hash. Falls back to the raw row
// if it can't be cast, so one odd row can't abort the whole report.
function normalized(doc) {
  try {
    const obj = new SachikoLabelStock(doc).toObject();
    delete obj._id;
    return obj;
  } catch {
    return doc;
  }
}

const label = (d) =>
  `${d.productCode || "(no product code)"}  |  SKU ${d.skuCode || "(none)"}  |  _id ${d._id}`;

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing signature changes)" : "DRY-RUN (no changes)"}\n`);

const all = await SachikoLabelStock.find().sort({ skuCode: 1 }).lean();
console.log(`Label Stock rows on the page: ${all.length}\n`);

// ---------------------------------------------------------------------------
// 1. Resync labelStockSignature
// ---------------------------------------------------------------------------
console.log("=== 1. Signature resync ===");

const desired = new Map(); // _id -> fresh full signature
for (const doc of all) desired.set(String(doc._id), buildLabelStockSignature(doc));

const stale = all.filter((doc) => desired.get(String(doc._id)) !== doc.labelStockSignature);
console.log(`Rows whose stored signature is missing or stale: ${stale.length}`);

let filled = 0;
let resynced = 0;
let skipped = 0;

for (const doc of stale) {
  const signature = desired.get(String(doc._id));
  const wasMissing = !doc.labelStockSignature;

  // Would this fresh signature land on top of a DIFFERENT row?
  const clash = all.find((o) => String(o._id) !== String(doc._id) && desired.get(String(o._id)) === signature);
  if (clash) {
    console.log(`  SKIP    ${label(doc)}\n          collides with ${label(clash)} -- resolve by hand`);
    skipped++;
    continue;
  }

  console.log(`  ${wasMissing ? "FILL  " : "RESYNC"}  ${label(doc)}`);
  if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { labelStockSignature: signature } });
  if (wasMissing) filled++;
  else resynced++;
}

console.log(
  `\n  Filled (was missing):      ${filled}` +
  `\n  Resynced (stale formula):  ${resynced}` +
  `\n  Skipped (would collide):   ${skipped}` +
  `\n  ${APPLY ? "Signature changes committed." : "Dry-run -- re-run with --apply to write."}\n`,
);

// ---------------------------------------------------------------------------
// 2. Same-spec rows (identical recipe, Product Code aside)
// ---------------------------------------------------------------------------
console.log("=== 2. Rows with the same specs ===");

const groups = new Map(); // specSignature -> [docs]
for (const doc of all) {
  const specSig = buildLabelStockSpecSignature(normalized(doc));
  if (!groups.has(specSig)) groups.set(specSig, []);
  groups.get(specSig).push(doc);
}

const dupGroups = [...groups.values()].filter((rows) => rows.length > 1);

if (!dupGroups.length) {
  console.log("None -- every row on the page is a distinct recipe.\n");
} else {
  console.log(
    `${dupGroups.length} group(s) of rows share an identical recipe ` +
    `(${dupGroups.reduce((n, r) => n + r.length, 0)} rows total):\n`,
  );

  dupGroups
    .sort((a, b) => String(a[0].productCode || "").localeCompare(String(b[0].productCode || "")))
    .forEach((rows, i) => {
      const fullSigs = new Set(rows.map((d) => desired.get(String(d._id))));
      const exact = fullSigs.size < rows.length; // two rows agree on Product Code too
      console.log(`  Group ${i + 1}  (${rows.length} rows${exact ? "  -- contains EXACT duplicates" : ""})`);
      rows
        .sort((a, b) => String(a.skuCode || "").localeCompare(String(b.skuCode || "")))
        .forEach((d) => console.log(`     - ${label(d)}`));
      console.log("");
    });
}

console.log("Done.");
await SachikoLabelStock.db.close();
process.exit(0);
