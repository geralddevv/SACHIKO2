import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";

// ---------------------------------------------------------------------------
// One-time repair for AdhesiveMaster's duplicate-prevention signature.
//
// adhesiveSignature replaced the old vendorId+vendorSkuCode compound unique
// index (create/edit now only blocks an exact full-record duplicate -- see
// buildAdhesiveSignature in routes/system/adhesiveMaster.js). This script:
//
//   1. Drops the old `vendorId_1_vendorSkuCode_1` index, if it still exists
//      in MongoDB (removing the field from the Mongoose schema does not, by
//      itself, drop an index already built on the collection).
//   2. Backfills adhesiveSignature on any row missing one (pre-existing
//      rows from before this field existed), using the same hash the live
//      route computes. A row whose computed signature would collide with
//      another row's is left alone and reported -- fix the data by hand,
//      since this script won't try to modify existing field values.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-adhesive-signatures.js           # preview
//   node scripts/backfill-adhesive-signatures.js --apply   # commit
// ---------------------------------------------------------------------------

import crypto from "crypto";

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}
function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function buildAdhesiveSignature(doc) {
  return hashSignature(
    [
      String(doc.vendorId || ""),
      canonStr(doc.type),
      canonStr(doc.make),
      canonStr(doc.vendorSkuCode),
      String(Number(doc.viscosity ?? "")),
      String(Number(doc.cohesion ?? "")),
      String(Number(doc.shear ?? "")),
      String(Number(doc.density ?? "")),
    ].join("||"),
  );
}

const APPLY = process.argv.includes("--apply");
const OLD_INDEX_NAME = "vendorId_1_vendorSkuCode_1";

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const existingIndexes = await AdhesiveMaster.collection.indexes();
const oldIndex = existingIndexes.find((idx) => idx.name === OLD_INDEX_NAME);
if (oldIndex) {
  console.log(`Old index found: ${OLD_INDEX_NAME}`);
  if (APPLY) {
    await AdhesiveMaster.collection.dropIndex(OLD_INDEX_NAME);
    console.log(`  -> dropped.`);
  } else {
    console.log(`  -> would drop (re-run with --apply).`);
  }
} else {
  console.log(`Old index ${OLD_INDEX_NAME} not present -- nothing to drop.`);
}

const missing = await AdhesiveMaster.find({
  $or: [{ adhesiveSignature: { $exists: false } }, { adhesiveSignature: null }, { adhesiveSignature: "" }],
}).lean();

console.log(`\nAdhesive masters missing a signature: ${missing.length}`);

let filled = 0;
let skipped = 0;

for (const doc of missing) {
  const label = `${doc.skuId || "(no SKU ID)"} / ${doc.vendorSkuCode || "(no vendor SKU code)"} (_id ${doc._id})`;
  const signature = buildAdhesiveSignature(doc);

  const collision = await AdhesiveMaster.findOne({ adhesiveSignature: signature, _id: { $ne: doc._id } })
    .select("_id skuId")
    .lean();
  if (collision) {
    console.log(`SKIP     ${label} -- would collide with ${collision.skuId} (_id ${collision._id}); resolve manually.`);
    skipped++;
    continue;
  }

  console.log(`FILL     ${label}`);
  if (APPLY) await AdhesiveMaster.updateOne({ _id: doc._id }, { $set: { adhesiveSignature: signature } });
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(`Skipped:  ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await AdhesiveMaster.db.close();
process.exit(0);
