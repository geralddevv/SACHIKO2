import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import FacestockMaster from "../../models/inventory/facestockMaster.js";

// ---------------------------------------------------------------------------
// One-time repair for FacestockMaster's duplicate-prevention signature.
//
// facestockSignature replaced the old vendorId+vendorSkuCode compound unique
// index (create/edit now only blocks an exact full-record duplicate -- see
// buildFacestockSignature in routes/system/facestockMaster.js). This script:
//
//   1. Drops the old `vendorId_1_vendorSkuCode_1` index, if it still exists
//      in MongoDB (removing the field from the Mongoose schema does not, by
//      itself, drop an index already built on the collection).
//   2. Backfills facestockSignature on any row missing one (pre-existing
//      rows from before this field existed), using the same hash the live
//      route computes. A row whose computed signature would collide with
//      another row's is left alone and reported -- fix the data by hand,
//      since this script won't try to modify existing field values.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-facestock-signatures.js           # preview
//   node scripts/backfill-facestock-signatures.js --apply   # commit
// ---------------------------------------------------------------------------

import crypto from "crypto";

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}
function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function buildFacestockSignature(doc) {
  return hashSignature(
    [
      String(doc.vendorId || ""),
      canonStr(doc.family),
      canonStr(doc.make),
      canonStr(doc.vendorSkuCode),
      canonStr(doc.type),
      canonStr(doc.size),
      String(Number(doc.gsm ?? "")),
      String(Number(doc.micron ?? "")),
    ].join("||"),
  );
}

const APPLY = process.argv.includes("--apply");
const OLD_INDEX_NAME = "vendorId_1_vendorSkuCode_1";

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const existingIndexes = await FacestockMaster.collection.indexes();
const oldIndex = existingIndexes.find((idx) => idx.name === OLD_INDEX_NAME);
if (oldIndex) {
  console.log(`Old index found: ${OLD_INDEX_NAME}`);
  if (APPLY) {
    await FacestockMaster.collection.dropIndex(OLD_INDEX_NAME);
    console.log(`  -> dropped.`);
  } else {
    console.log(`  -> would drop (re-run with --apply).`);
  }
} else {
  console.log(`Old index ${OLD_INDEX_NAME} not present -- nothing to drop.`);
}

const missing = await FacestockMaster.find({
  $or: [{ facestockSignature: { $exists: false } }, { facestockSignature: null }, { facestockSignature: "" }],
}).lean();

console.log(`\nFacestock masters missing a signature: ${missing.length}`);

let filled = 0;
let skipped = 0;

for (const doc of missing) {
  const label = `${doc.skuId || "(no SKU ID)"} / ${doc.vendorSkuCode || "(no vendor SKU code)"} (_id ${doc._id})`;
  const signature = buildFacestockSignature(doc);

  const collision = await FacestockMaster.findOne({ facestockSignature: signature, _id: { $ne: doc._id } })
    .select("_id skuId")
    .lean();
  if (collision) {
    console.log(`SKIP     ${label} -- would collide with ${collision.skuId} (_id ${collision._id}); resolve manually.`);
    skipped++;
    continue;
  }

  console.log(`FILL     ${label}`);
  if (APPLY) await FacestockMaster.updateOne({ _id: doc._id }, { $set: { facestockSignature: signature } });
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(`Skipped:  ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await FacestockMaster.db.close();
process.exit(0);
