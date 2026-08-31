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

// Every row whose SKU actually moves, in BASE-then-VARIANT print order.
const changes = [];
for (const doc of baseDocs) {
  const newSku = newSkuById.get(doc._id.toString());
  if (newSku === doc.skuCode) continue;
  changes.push({ doc, newSku, kind: "BASE    ", note: "" });
}
for (const { doc, baseDoc } of variantDocs) {
  const newSku = newSkuById.get(doc._id.toString());
  if (newSku === doc.skuCode) continue;
  changes.push({ doc, newSku, kind: "VARIANT ", note: `  (base: ${baseDoc.productCode})` });
}

for (const { doc, newSku, kind, note } of changes) {
  console.log(`${kind} ${doc.productCode || "(no product code)"} / ${doc.labelStockId || "(no ID)"} (_id ${doc._id})${note}`);
  console.log(`           "${doc.skuCode}" -> "${newSku}"`);
}

// skuCode carries a unique index, and a row's new SKU is very often one that
// another row is still holding -- so the mapping cannot simply be looped over
// and written. Ordering the writes does not rescue it either: this used to
// process base rows in ascending new-number order on the reasoning that a new
// number is never higher than the old one, which is only true when the old
// numbering ran in the same order as `createdAt`. It doesn't. A row created
// early can hold a high old number (or, after past hand-edits, a variant-
// shaped SKU like "SP | LS | 000013-A" on a base row), so its new number goes
// UP and lands on a row not yet processed -- E11000. And no ordering can fix
// the general case anyway, because the mapping may contain cycles: two rows
// swapping numbers have no safe order at all.
//
// So: park every changing row on a temporary value first, then land them all.
// Two passes, no collisions, whatever the mapping looks like.
//
// The temp value is built from _id -- unique by construction, and prefixed
// with something no real SKU contains, so it can collide with neither an old
// nor a new SKU. If a run dies between the passes, some rows are left parked;
// simply re-running the script finishes the job, because the mapping is
// derived from productCode and createdAt only and never reads the current
// skuCode. (A dry run will show those rows as `"__reseq__..." -> "SP | ..."`.)
const tempSkuFor = (doc) => `__reseq__${doc._id}`;

if (APPLY && changes.length) {
  try {
    for (const { doc } of changes) {
      await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { skuCode: tempSkuFor(doc) } });
    }
    for (const { doc, newSku } of changes) {
      await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { skuCode: newSku } });
    }
  } catch (err) {
    console.error(`\nFAILED part-way through: ${err.message}`);
    console.error("Some rows may be left on a temporary \"__reseq__<id>\" skuCode.");
    console.error("Re-run this script (dry-run first) -- it recomputes the same");
    console.error("mapping from productCode/createdAt and will finish the move.");
    process.exitCode = 1;
    await SachikoLabelStock.db.close();
    process.exit(1);
  }
}

const changed = changes.length;

console.log(`\n--- Summary ---`);
console.log(`Records ${APPLY ? "updated" : "that would change"}: ${changed} / ${docs.length}`);
console.log(APPLY ? "Database serialized successfully." : "Dry-run complete. Re-run with --apply to commit.");

if (APPLY) {
  const finalCount = await SachikoLabelStock.countDocuments();
  const distinctSkus = (await SachikoLabelStock.distinct("skuCode")).length;
  if (distinctSkus !== finalCount) {
    console.error(`\nWARNING: post-apply skuCode count (${distinctSkus}) does not match document count (${finalCount}) -- investigate before trusting the data.`);
  }
  // Nothing should still be parked once both passes have run.
  const stranded = await SachikoLabelStock.countDocuments({ skuCode: /^__reseq__/ });
  if (stranded) {
    console.error(`\nWARNING: ${stranded} row(s) still hold a temporary "__reseq__<id>" skuCode -- re-run this script to finish moving them.`);
  }
}

await SachikoLabelStock.db.close();
process.exit(0);
