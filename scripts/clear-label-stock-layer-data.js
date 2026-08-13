import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// One-time cleanup for SachikoLabelStock's facestock/facestock2/adhesive/
// adhesive2/releaseLiner/releaseLiner2 sub-documents (the Layer Stack on
// views/sachiko/labelStockView.ejs's New/Edit dialog).
//
// Every one of those fields is meant to be picked from FacestockMaster/
// AdhesiveMaster/ReleaseMaster through the dialog's Family/Type/Make/Vendor/.../
// smart-filter cascade, which fills in the matching master row's vendorId,
// vendorName, vendorSkuCode etc. alongside whatever the operator typed.
// Existing rows (largely from scripts/migrate-fairdesk-papers-to-label-stock.js,
// or from the standalone edit page's now-fixed prefill bug) instead carry
// free-typed or partial values (e.g. facestockType only, no make/vendor/gsm)
// that don't correspond to any one master row -- the dialog's cascade has
// nowhere to seed those fields *from*, so they show up blank or "(not in
// master)" instead of a clean selection.
//
// This wipes those six sub-documents on every Label Stock row, leaving
// productCode/rollType/family/rollOrSheet/printingTechnology/digitalPrintType
// and the word file untouched, so every row starts from a clean slate and has
// to be re-picked from the current master data on next edit -- instead of
// carrying stale detail forward indefinitely.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/clear-label-stock-layer-data.js           # preview
//   node scripts/clear-label-stock-layer-data.js --apply   # commit
// ---------------------------------------------------------------------------

const LAYER_FIELDS = ["facestock", "facestock2", "adhesive", "adhesive2", "releaseLiner", "releaseLiner2"];

const APPLY = process.argv.includes("--apply");

await connectDB();

const rows = await SachikoLabelStock.find({
  $or: LAYER_FIELDS.map((f) => ({ [f]: { $exists: true } })),
})
  .select(["_id", "labelStockId", "productCode", ...LAYER_FIELDS].join(" "))
  .lean();

console.log(`Label Stocks carrying layer data: ${rows.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let cleared = 0;

for (const ls of rows) {
  const present = LAYER_FIELDS.filter((f) => ls[f] != null);
  if (present.length === 0) continue;

  const label = `${ls.productCode || "(no product code)"} / ${ls.labelStockId || "(no label stock id)"} (_id ${ls._id})`;
  console.log(`CLEAR    ${label}`);
  console.log(`           -> unset ${present.join(", ")}`);

  if (APPLY) {
    const unset = {};
    for (const f of present) unset[f] = "";
    await SachikoLabelStock.updateOne({ _id: ls._id }, { $unset: unset });
  }

  cleared++;
}

console.log(`\n--- Summary ---`);
console.log(`Cleared:  ${cleared}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
