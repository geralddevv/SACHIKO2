import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import CoreMaster from "../models/inventory/coreMaster.js";
import Counter from "../models/system/counter.js";

// ---------------------------------------------------------------------------
// Script: Reserializes CoreMaster `skuId` fields (e.g. SP | COR | 000001,
// SP | COR | 000002, ...) sequentially based on creation order, and resets the
// `coreMasterSkuId` Counter sequence to match the total document count.
//
// Usage:
//   node scripts/serialize-core-master-ids.js           # preview (dry-run)
//   node scripts/serialize-core-master-ids.js --apply   # commit changes
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const docs = await CoreMaster.find().sort({ createdAt: 1 }).lean();
console.log(`Found ${docs.length} Core Master records to serialize.`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let updatedCount = 0;

for (let i = 0; i < docs.length; i++) {
  const doc = docs[i];
  const seq = i + 1;
  const newSkuId = `SP | COR | ${String(seq).padStart(6, "0")}`;
  const oldSkuId = doc.skuId;

  console.log(`RECORD ${seq}/${docs.length}:`);
  console.log(`  _id:           ${doc._id}`);
  console.log(`  Vendor:        ${doc.vendorName || "(no vendor)"}`);
  console.log(`  Type/Make:     ${doc.type || "-"} / ${doc.make || "-"}`);
  console.log(`  skuId:         "${oldSkuId}" -> "${newSkuId}"`);

  if (APPLY) {
    await CoreMaster.updateOne({ _id: doc._id }, { $set: { skuId: newSkuId } });
  }
  updatedCount++;
}

if (APPLY) {
  await Counter.updateOne(
    { key: "coreMasterSkuId" },
    { $set: { seq: docs.length } },
    { upsert: true }
  );
  console.log(`\nUpdated Counter "coreMasterSkuId" sequence to ${docs.length}.`);
} else {
  console.log(`\nWould update Counter "coreMasterSkuId" sequence to ${docs.length}.`);
}

console.log(`\n--- Summary ---`);
console.log(`Records ${APPLY ? "serialized & committed" : "matched (dry-run)"}: ${updatedCount}`);
console.log(APPLY ? "Database serialized successfully." : "Dry-run complete. Re-run with --apply to commit.");

await CoreMaster.db.close();
process.exit(0);
