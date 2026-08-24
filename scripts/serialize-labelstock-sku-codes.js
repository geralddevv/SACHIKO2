import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// Reserializes SachikoLabelStock `skuCode` so:
//   - "Base" rows (a Product Code with no variant family, e.g. "C011") get a
//     contiguous sequence with no gaps: SP | LS | 000001, 000002, ... --
//     existing rows have gaps (e.g. 000014-000018 missing) left behind by
//     past deletions.
//   - Variant rows (Product Code "<base>-<LETTER>", e.g. "C011-A") get their
//     BASE row's own (possibly newly-resequenced) SKU with the same letter
//     suffix appended -- "SP | LS | 000003-A" -- instead of a disconnected
//     number of their own, matching what routes/sachiko/sachiko_route.js's
//     POST /label-stock/form and utils/labelStockVariant.js's
//     resolveLabelStockSkuCode now do for newly created variants.
//
// Existing letter suffixes are preserved as-is (only the base number prefix
// changes) -- this script re-anchors variants to their base, it does not
// reassign which letter a variant holds.
//
// A row named "<something>-<LETTER>" whose base row can't be found (the base
// was deleted, or it's a standalone Product Code that just happens to end in
// "-<LETTER>") is treated as its own base and given a plain sequential
// number, same as resolveLabelStockProductCode's own variantFamilyRoot falls
// back.
//
// Base rows are ordered by createdAt (creation order), matching
// scripts/archive/serialize-facestock-master-ids.js and friends.
//
// Dry-run by default -- prints every old -> new mapping and refuses to write
// if anything looks off (e.g. two rows would collide on the same new SKU).
//
//   node scripts/serialize-labelstock-sku-codes.js           # preview
//   node scripts/serialize-labelstock-sku-codes.js --apply   # commit
// ---------------------------------------------------------------------------

const formatSkuCode = (n) => `SP | LS | ${String(n).padStart(6, "0")}`;
// Same single-letter-only suffix resolveLabelStockProductCode/
// variantFamilyRoot (utils/labelStockVariant.js) ever mints.
const VARIANT_RE = /^(.*[^-])-([A-Z])$/;

const APPLY = process.argv.includes("--apply");

await connectDB();

const docs = await SachikoLabelStock.find().sort({ createdAt: 1 }).select("skuCode productCode labelStockId createdAt").lean();
console.log(`Found ${docs.length} Label Stock records.`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const byProductCode = new Map(docs.map((d) => [d.productCode, d]));

const baseDocs = [];
const variantDocs = [];
for (const doc of docs) {
  const match = VARIANT_RE.exec(String(doc.productCode || ""));
  const baseDoc = match ? byProductCode.get(match[1]) : null;
  if (baseDoc && baseDoc._id.toString() !== doc._id.toString()) {
    variantDocs.push({ doc, baseDoc, suffix: match[2] });
  } else {
    baseDocs.push(doc);
  }
}

// Base rows keep their relative (creation) order but get a contiguous
// sequence -- this is what closes the gaps.
const newSkuById = new Map();
baseDocs.forEach((doc, i) => {
  newSkuById.set(doc._id.toString(), formatSkuCode(i + 1));
});

// Variants inherit their base's (possibly just-reassigned) new SKU, letter
// suffix unchanged. Resolved in passes rather than a single loop so a
// variant whose "base" is itself another variant (shouldn't happen given
// resolveLabelStockProductCode only ever mints single-level suffixes, but
// this doesn't assume that) still resolves correctly once its own base is
// known.
let pending = variantDocs.slice();
while (pending.length) {
  const stillPending = [];
  let resolvedAny = false;
  for (const entry of pending) {
    const baseNewSku = newSkuById.get(entry.baseDoc._id.toString());
    if (baseNewSku) {
      newSkuById.set(entry.doc._id.toString(), `${baseNewSku}-${entry.suffix}`);
      resolvedAny = true;
    } else {
      stillPending.push(entry);
    }
  }
  if (!resolvedAny) {
    console.error("Could not resolve a new SKU for the following variant(s) -- their base row's new SKU is unknown (cyclic or broken family chain):");
    for (const { doc, baseDoc } of stillPending) {
      console.error(`  ${doc.productCode} (_id ${doc._id}) -> base ${baseDoc.productCode} (_id ${baseDoc._id})`);
    }
    process.exitCode = 1;
    await SachikoLabelStock.db.close();
    process.exit(1);
  }
  pending = stillPending;
}

// Sanity check before touching the database: every computed new SKU must be
// unique. A collision here means the script's assumptions don't hold for
// this data -- refuse to write anything rather than risk a wrong merge.
const seen = new Map();
let hasCollision = false;
for (const doc of docs) {
  const newSku = newSkuById.get(doc._id.toString());
  if (seen.has(newSku)) {
    hasCollision = true;
    console.error(`COLLISION: "${newSku}" would be assigned to both ${seen.get(newSku)} and ${doc.productCode} (_id ${doc._id}).`);
  }
  seen.set(newSku, `${doc.productCode} (_id ${doc._id})`);
}
if (hasCollision) {
  console.error("\nRefusing to proceed -- fix the underlying data (e.g. duplicate variant letters) and re-run.");
  process.exitCode = 1;
  await SachikoLabelStock.db.close();
  process.exit(1);
}

console.log(`Base rows (contiguous 000001-${String(baseDocs.length).padStart(6, "0")}): ${baseDocs.length}`);
console.log(`Variant rows (re-anchored to base): ${variantDocs.length}\n`);

let changed = 0;
// Process base rows first, in ascending new-number order: each base row's
// new number is always <= its own old number (closing gaps only shrinks),
// and every row processed later still holds an old SKU strictly greater than
// any number already written, so no in-flight collision with an
// not-yet-updated row is possible.
for (const doc of baseDocs) {
  const newSku = newSkuById.get(doc._id.toString());
  const label = `${doc.productCode || "(no product code)"} / ${doc.labelStockId || "(no ID)"} (_id ${doc._id})`;
  if (newSku === doc.skuCode) continue;
  console.log(`BASE     ${label}`);
  console.log(`           "${doc.skuCode}" -> "${newSku}"`);
  if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { skuCode: newSku } });
  changed++;
}
for (const { doc, baseDoc, suffix } of variantDocs) {
  const newSku = newSkuById.get(doc._id.toString());
  const label = `${doc.productCode || "(no product code)"} / ${doc.labelStockId || "(no ID)"} (_id ${doc._id})`;
  if (newSku === doc.skuCode) continue;
  console.log(`VARIANT  ${label}  (base: ${baseDoc.productCode})`);
  console.log(`           "${doc.skuCode}" -> "${newSku}"`);
  if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { skuCode: newSku } });
  changed++;
}

console.log(`\n--- Summary ---`);
console.log(`Records ${APPLY ? "updated" : "that would change"}: ${changed} / ${docs.length}`);
console.log(APPLY ? "Database serialized successfully." : "Dry-run complete. Re-run with --apply to commit.");

if (APPLY) {
  const finalCount = await SachikoLabelStock.countDocuments();
  const distinctSkus = (await SachikoLabelStock.distinct("skuCode")).length;
  if (distinctSkus !== finalCount) {
    console.error(`\nWARNING: post-apply skuCode count (${distinctSkus}) does not match document count (${finalCount}) -- investigate before trusting the data.`);
  }
}

await SachikoLabelStock.db.close();
process.exit(0);
