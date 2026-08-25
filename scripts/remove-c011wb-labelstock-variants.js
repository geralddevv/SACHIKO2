import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import FinishedStock from "../models/inventory/finishedStock.js";
import FinishedStockLog from "../models/inventory/finishedStockLog.js";
import LabelStockBinding from "../models/sachiko/labelStockBinding.js";
import LabelStockAdhesiveBinding from "../models/sachiko/labelStockAdhesiveBinding.js";
import PendingProduction from "../models/inventory/pendingProduction.js";

// ---------------------------------------------------------------------------
// Removes Label Stock variant records for the C011WB family (C011WB-A,
// C011WB-B, ...) -- mirrors scripts/strip-c011-labelstock-variant-suffixes.js,
// but checks the REAL field names every other collection actually uses to
// reference a SachikoLabelStock document. That older script only checked
// labelStock/labelStockId/itemId/labelStock_id/layers.labelStockId -- which
// MISSES MaterialStock/MaterialStockLog/FinishedStock/FinishedStockLog's own
// `material` field, the one Semi Finished Stock (produced Deckles) actually
// uses (models/inventory/materialStock.js). A variant with real Deckle stock
// under it would have been wrongly reported "safe to delete" by that check.
//
// The script keeps the base C011WB record and only ever considers removing
// its "-A"/"-B"/... variants, after verifying none of them are referenced by:
//   - MaterialStock / MaterialStockLog (`material`)      -- Semi Finished Stock
//   - FinishedStock / FinishedStockLog (`material`)       -- dispatched stock
//   - LabelStockBinding / LabelStockAdhesiveBinding (`labelStock`)
//   - PendingProduction (`itemId`)                         -- open orders
//
// Dry-run by default:
//   node scripts/remove-c011wb-labelstock-variants.js
//
// Apply (remove variant rows from the database):
//   node scripts/remove-c011wb-labelstock-variants.js --apply
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const BASE_PRODUCT_CODE = "C011WB";
const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "uploads", "sachiko", "label_stock");

function labelOf(doc) {
  return `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU)"} / ${doc.labelStockId || "(no ID)"} (_id ${doc._id})`;
}

// One row per place that could reference a SachikoLabelStock _id, in the
// field that model actually uses -- not a generic multi-collection scan, so
// a renamed/added reference elsewhere won't silently be missed the way a
// guessed field-name list would.
async function checkForeignReferences(docId) {
  const refs = [];
  const checks = [
    { label: "MaterialStock (Semi Finished Stock)", Model: MaterialStock, field: "material" },
    { label: "MaterialStockLog", Model: MaterialStockLog, field: "material" },
    { label: "FinishedStock", Model: FinishedStock, field: "material" },
    { label: "FinishedStockLog", Model: FinishedStockLog, field: "material" },
    { label: "LabelStockBinding", Model: LabelStockBinding, field: "labelStock" },
    { label: "LabelStockAdhesiveBinding", Model: LabelStockAdhesiveBinding, field: "labelStock" },
    { label: "PendingProduction", Model: PendingProduction, field: "itemId" },
  ];
  for (const { label, Model, field } of checks) {
    const count = await Model.countDocuments({ [field]: docId });
    if (count > 0) refs.push(`${label} (${count} doc${count === 1 ? "" : "s"})`);
  }
  return refs;
}

try {
  await connectDB();

  // Find every C011WB row (base + all variants).
  const allC011wb = await SachikoLabelStock.find({
    $or: [
      { productCode: BASE_PRODUCT_CODE },
      { productCode: new RegExp(`^${BASE_PRODUCT_CODE}-[A-Z]+$`, "i") },
    ],
  })
    .sort({ createdAt: 1, labelStockId: 1 })
    .lean();

  console.log(`Mode: ${APPLY ? "APPLY (removing variants)" : "DRY-RUN (no changes)"}`);
  console.log(`Target: ${BASE_PRODUCT_CODE} family rows`);
  console.log(`Total ${BASE_PRODUCT_CODE} rows found: ${allC011wb.length}`);

  const baseDoc = allC011wb.find((d) => d.productCode === BASE_PRODUCT_CODE) || allC011wb[0];
  const subRows = allC011wb.filter((d) => d._id.toString() !== baseDoc?._id?.toString());

  if (!subRows.length) {
    console.log(`\nNo ${BASE_PRODUCT_CODE} variant rows exist. Nothing to remove.`);
    process.exit(0);
  }

  console.log(`\nPrimary base row (KEEPING):`);
  console.log(`  ${labelOf(baseDoc)}`);

  console.log(`\nVariant rows (checking for references):`);
  const safeToDelete = [];
  const blocked = [];

  for (const doc of subRows) {
    const refs = await checkForeignReferences(doc._id);
    if (refs.length > 0) {
      blocked.push({ doc, refs });
      console.log(`  [BLOCKED] ${labelOf(doc)} -> referenced in: ${refs.join(", ")}`);
    } else {
      safeToDelete.push(doc);
      console.log(`  [SAFE]    ${labelOf(doc)} -> no foreign references`);
    }
  }

  if (blocked.length > 0) {
    console.warn(`\nWarning: ${blocked.length} row(s) cannot be safely deleted -- real stock/orders still reference them.`);
    console.warn(`Deleting them anyway would orphan that stock (it would keep existing, just pointing at a LabelStock that no longer exists).`);
  }

  if (!safeToDelete.length) {
    console.log(`\nNo ${BASE_PRODUCT_CODE} variant rows are safe to remove.`);
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDry-run preview complete. ${safeToDelete.length} variant row(s) ready to be removed.`);
    console.log("Re-run with --apply to remove these rows from the database.");
    process.exit(0);
  }

  console.log("\nApplying changes...");
  for (const doc of safeToDelete) {
    await SachikoLabelStock.deleteOne({ _id: doc._id });

    if (doc.wordFile) {
      const filePath = path.join(UPLOAD_DIR, doc.wordFile);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn(`  Could not remove file ${doc.wordFile}: ${e.message}`);
        }
      }
    }
    console.log(`  ✓ Removed ${labelOf(doc)}`);
  }

  console.log(`\nSuccessfully removed ${safeToDelete.length} ${BASE_PRODUCT_CODE} variant row(s).`);
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
