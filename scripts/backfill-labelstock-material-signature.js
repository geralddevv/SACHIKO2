import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import { buildMaterialSignature } from "../utils/labelStockVariant.js";

// ---------------------------------------------------------------------------
// Backfill for SachikoLabelStock.materialSignature -- added so another
// module can key off "same physical material stack" (see buildMaterialSignature
// in utils/labelStockVariant.js for the exact field list: the six facestock/
// adhesive/releaseLiner layers, minus Size/Shelf Life, no product-level
// fields). Every row created before this field existed has no
// materialSignature -- this fills it in from the row's own current data.
// Re-run any time buildMaterialSignature's field list changes, same as
// scripts/backfill-labelstock-signatures.js -- it resyncs a stale signature
// too, not just a missing one.
//
// Unlike labelStockSignature, materialSignature is NOT unique -- two rows
// legitimately sharing one just means the same material stack under
// different Product Codes, so this never skips a row for "colliding" with
// another; it just reports how many rows now share each hash.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-labelstock-material-signature.js           # preview
//   node scripts/backfill-labelstock-material-signature.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await SachikoLabelStock.find().lean();
const stale = all.filter((doc) => buildMaterialSignature(doc) !== doc.materialSignature);

console.log(`Label Stocks checked: ${all.length}`);
console.log(`Needing an update: ${stale.length}\n`);

let filled = 0;
let resynced = 0;

for (const doc of stale) {
  const label = `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} (_id ${doc._id})`;
  const signature = buildMaterialSignature(doc);
  const wasMissing = !doc.materialSignature;

  console.log(`${wasMissing ? "FILL   " : "RESYNC "}  ${label}`);
  if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { materialSignature: signature } });
  if (wasMissing) filled++;
  else resynced++;
}

// Purely informational -- shows which rows now share a material stack, so
// it's easy to sanity-check the field list actually groups what's expected.
const bySignature = new Map();
for (const doc of all) {
  const sig = stale.some((d) => String(d._id) === String(doc._id)) ? buildMaterialSignature(doc) : doc.materialSignature;
  if (!sig) continue;
  if (!bySignature.has(sig)) bySignature.set(sig, []);
  bySignature.get(sig).push(doc.productCode || doc.skuCode);
}
const shared = [...bySignature.values()].filter((codes) => codes.length > 1);
if (shared.length) {
  console.log(`\n--- Rows sharing a material signature ---`);
  shared.forEach((codes) => console.log(`  ${codes.join(", ")}`));
}

console.log(`\n--- Summary ---`);
console.log(`Filled (was missing): ${filled}`);
console.log(`Resynced (stale):     ${resynced}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
