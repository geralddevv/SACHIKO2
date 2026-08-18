import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// Migration script: Update existing SachikoLabelStock skuCode fields from "FS | ..." to "SP | ...".
// Example: "FS | LS | 000001" -> "SP | LS | 000001"
//
// Usage:
//   node scripts/update-label-stock-sku-code-fs-to-sp.js           # preview (dry-run)
//   node scripts/update-label-stock-sku-code-fs-to-sp.js --apply   # commit changes
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const docsToUpdate = await SachikoLabelStock.find({
  skuCode: { $regex: /^FS\s*\|\s*/i },
})
  .select("_id labelStockId skuCode productCode")
  .lean();

console.log(`Found ${docsToUpdate.length} Label Stock records with FS prefix in skuCode.`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let updatedCount = 0;

for (const doc of docsToUpdate) {
  const oldSku = doc.skuCode;
  const newSku = oldSku.replace(/^FS(\s*\|\s*)/i, "SP$1");
  const label = `${doc.productCode || "(no product code)"} / ${doc.labelStockId || "(no ID)"} (_id: ${doc._id})`;

  console.log(`UPDATE  ${label}`);
  console.log(`        "${oldSku}" -> "${newSku}"`);

  if (APPLY) {
    await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: { skuCode: newSku } });
  }
  updatedCount++;
}

console.log(`\n--- Summary ---`);
console.log(`Records ${APPLY ? "updated" : "matched"}: ${updatedCount}`);
console.log(APPLY ? "Database updated successfully." : "Dry-run complete. Run with --apply to write changes.");

await SachikoLabelStock.db.close();
process.exit(0);
