import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import CoreMaster from "../models/inventory/coreMaster.js";

// ---------------------------------------------------------------------------
// One-time backfill for CoreMaster.coreSignature -- the duplicate-prevention
// signature that blocks create/edit only on an exact full-record duplicate
// (see buildCoreSignature in routes/system/coreMaster.js). Core Master never
// had a narrower uniqueness index, so this script only needs to fill in the
// field for pre-existing rows; a row whose computed signature would collide
// with another row's is left alone and reported.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-core-signatures.js           # preview
//   node scripts/backfill-core-signatures.js --apply   # commit
// ---------------------------------------------------------------------------

import crypto from "crypto";

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}
function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function buildCoreSignature(doc) {
  return hashSignature(
    [
      String(doc.vendorId || ""),
      canonStr(doc.type),
      canonStr(doc.make),
      canonStr(doc.printType),
      String(Number(doc.thickness ?? "")),
      String(Number(doc.width ?? "")),
    ].join("||"),
  );
}

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const missing = await CoreMaster.find({
  $or: [{ coreSignature: { $exists: false } }, { coreSignature: null }, { coreSignature: "" }],
}).lean();

console.log(`Core masters missing a signature: ${missing.length}`);

let filled = 0;
let skipped = 0;

for (const doc of missing) {
  const label = `${doc.skuId || "(no SKU ID)"} (_id ${doc._id})`;
  const signature = buildCoreSignature(doc);

  const collision = await CoreMaster.findOne({ coreSignature: signature, _id: { $ne: doc._id } })
    .select("_id skuId")
    .lean();
  if (collision) {
    console.log(`SKIP     ${label} -- would collide with ${collision.skuId} (_id ${collision._id}); resolve manually.`);
    skipped++;
    continue;
  }

  console.log(`FILL     ${label}`);
  if (APPLY) await CoreMaster.updateOne({ _id: doc._id }, { $set: { coreSignature: signature } });
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(`Skipped:  ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await CoreMaster.db.close();
process.exit(0);
