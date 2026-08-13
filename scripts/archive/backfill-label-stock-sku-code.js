import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// One-time backfill for SachikoLabelStock.skuCode ("SKU Code" in the UI --
// views/sachiko/labelStockView.ejs's New/Edit dialog, labelStockBindingForm.ejs's
// SKU Code select, etc.). The field is `required: true, unique: true` on the schema,
// but a record predating that constraint (or written straight to the
// database) can still end up without one -- e.g. a record still carrying its
// old "SP | DS | ..." labelStockId from before the datasheet -> label stock
// rename, with no skuCode at all.
//
// Uses the exact same format/allocation the live app uses (formatSkuCode /
// generateSkuCode in routes/sachiko/sachiko_route.js): "FS | LS | 000001",
// continuing from the highest existing skuCode and skipping any value
// already taken, so a backfilled record is indistinguishable from one
// created normally.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-label-stock-sku-code.js           # preview
//   node scripts/backfill-label-stock-sku-code.js --apply   # commit
// ---------------------------------------------------------------------------

const formatSkuCode = (n) => `FS | LS | ${String(n).padStart(6, "0")}`;
const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

const APPLY = process.argv.includes("--apply");

await connectDB();

const missing = await SachikoLabelStock.find({
  $or: [{ skuCode: { $exists: false } }, { skuCode: null }, { skuCode: "" }],
})
  .select("_id labelStockId productCode")
  .lean();

console.log(`Label Stocks missing a SKU Code: ${missing.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let nextSeq = parseSkuSeq(
  (await SachikoLabelStock.findOne().sort({ skuCode: -1 }).select("skuCode").lean())?.skuCode,
) + 1;

let filled = 0;

for (const ls of missing) {
  const label = `${ls.productCode || "(no product code)"} / ${ls.labelStockId || "(no label stock id)"} (_id ${ls._id})`;

  let candidate = formatSkuCode(nextSeq);
  while (await SachikoLabelStock.exists({ skuCode: candidate })) {
    nextSeq += 1;
    candidate = formatSkuCode(nextSeq);
  }

  console.log(`FILL     ${label}`);
  console.log(`           -> "${candidate}"`);

  if (APPLY) await SachikoLabelStock.updateOne({ _id: ls._id }, { $set: { skuCode: candidate } });

  nextSeq += 1;
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
