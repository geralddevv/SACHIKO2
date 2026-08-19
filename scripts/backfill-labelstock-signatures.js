import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Backfill for SachikoLabelStock.labelStockSignature -- added so the Label
// Stock create/edit dialog (views/sachiko/labelStockView.ejs) can block a
// duplicate the same way Facestock/Adhesive/Release Master and Label Stock
// Binding already do (see buildLabelStockSignature in
// routes/sachiko/sachiko_route.js): only when every user-editable field
// (Product Code, Roll Type, Family, Roll/Sheet, Printing Technology, and all
// six facestock/adhesive/releaseLiner layers) matches an existing row
// exactly.
//
// Every row created before this field existed has no labelStockSignature --
// this fills it in from the row's own current data. Re-run any time
// buildLabelStockSignature's field list changes, same as the Master
// signature scripts -- it resyncs a stale signature too, not just a missing
// one. A row whose recomputed signature would collide with another row's is
// left alone and reported; that means two rows are already exact duplicates
// today, which needs a human decision (merge/edit one), not a script guess.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-labelstock-signatures.js           # preview
//   node scripts/backfill-labelstock-signatures.js --apply   # commit
// ---------------------------------------------------------------------------

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}
function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function canonNum(value) {
  return value === undefined || value === null || value === "" ? "" : String(Number(value));
}

const FS_SIG_FIELDS = ["facestockFamily", "facestockType", "facestockMake", "facestockVendorId", "facestockVendorSkuCode", "facestockSize"];
const FS_SIG_NUM_FIELDS = ["facestockGsm", "facestockMicron"];
const AD_SIG_FIELDS = ["adhesiveType", "adhesiveMake", "adhesiveVendorId", "adhesiveVendorSkuCode", "adhesiveShelfLife"];
const AD_SIG_NUM_FIELDS = ["adhesiveGsm", "adhesiveViscosity", "adhesiveCohesion", "adhesiveShear", "adhesiveDensity"];
const RL_SIG_FIELDS = ["releaseLinerType", "releaseLinerMake", "releaseLinerSensing", "releaseLinerVendorId", "releaseLinerVendorSkuCode", "releaseLinerColor", "releaseLinerSize"];
const RL_SIG_NUM_FIELDS = ["releaseLinerGsm"];

function layerSignaturePart(layer, strFields, numFields) {
  if (!layer) return "";
  return strFields.map((f) => canonStr(layer[f])).concat(numFields.map((f) => canonNum(layer[f]))).join("|");
}

function buildLabelStockSignature(doc) {
  return hashSignature(
    [
      canonStr(doc.productCode),
      canonStr(doc.rollType),
      canonStr(doc.family),
      canonStr(doc.rollOrSheet),
      canonStr(doc.printingTechnology),
      canonStr(doc.digitalPrintType),
      layerSignaturePart(doc.facestock, FS_SIG_FIELDS, FS_SIG_NUM_FIELDS),
      layerSignaturePart(doc.adhesive, AD_SIG_FIELDS, AD_SIG_NUM_FIELDS),
      layerSignaturePart(doc.releaseLiner, RL_SIG_FIELDS, RL_SIG_NUM_FIELDS),
      layerSignaturePart(doc.facestock2, FS_SIG_FIELDS, FS_SIG_NUM_FIELDS),
      layerSignaturePart(doc.adhesive2, AD_SIG_FIELDS, AD_SIG_NUM_FIELDS),
      layerSignaturePart(doc.releaseLiner2, RL_SIG_FIELDS, RL_SIG_NUM_FIELDS),
    ].join("||"),
  );
}

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await SachikoLabelStock.find().lean();
const stale = all.filter((doc) => buildLabelStockSignature(doc) !== doc.labelStockSignature);

console.log(`Label Stocks checked: ${all.length}`);
console.log(`Needing a signature update: ${stale.length}`);

let filled = 0;
let resynced = 0;
let skipped = 0;

for (const doc of stale) {
  const label = `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} (_id ${doc._id})`;
  const signature = buildLabelStockSignature(doc);
  const wasMissing = !doc.labelStockSignature;

  const collision = await SachikoLabelStock.findOne({ labelStockSignature: signature, _id: { $ne: doc._id } })
    .select("_id productCode skuCode")
    .lean();
  if (collision) {
    console.log(`SKIP     ${label} -- would collide with ${collision.productCode}/${collision.skuCode} (_id ${collision._id}); resolve manually.`);
    skipped++;
    continue;
  }

  console.log(`${wasMissing ? "FILL   " : "RESYNC "}  ${label}`);
  if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { labelStockSignature: signature } });
  if (wasMissing) filled++;
  else resynced++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled (was missing):     ${filled}`);
console.log(`Resynced (stale formula): ${resynced}`);
console.log(`Skipped (collision):      ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
