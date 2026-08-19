import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Backfill for ReleaseMaster.releaseSignature -- the sha256 that stops two
// Release Masters holding the identical spec (see buildReleaseSignature in
// routes/system/releaseMaster.js).
//
// Run this after the Sensing field was added to the signature: every row
// saved before it existed hashed one fewer field, so its stored signature no
// longer matches what the route now computes, and a genuine duplicate of
// such a row would slip past the check. This recomputes each row's signature
// from its own current data.
//
// Re-run any time buildReleaseSignature's field list changes -- it resyncs a
// stale signature as well as filling in a missing one. A row whose
// recomputed signature would collide with another row's is left alone and
// reported: that means two masters already hold the exact same spec today,
// which needs a human decision (merge/edit one), not a script guess.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-release-signatures.js           # preview
//   node scripts/backfill-release-signatures.js --apply   # commit
// ---------------------------------------------------------------------------

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

// Must stay identical to buildReleaseSignature in routes/system/releaseMaster.js.
function buildReleaseSignature(doc) {
  return hashSignature(
    [
      String(doc.vendorId || ""),
      canonStr(doc.type),
      canonStr(doc.make),
      canonStr(doc.sensing),
      canonStr(doc.vendorSkuCode),
      canonStr(doc.color),
      canonStr(doc.size),
      String(Number(doc.gsm ?? "")),
    ].join("||"),
  );
}

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await ReleaseMaster.find().lean();
const stale = all.filter((doc) => buildReleaseSignature(doc) !== doc.releaseSignature);

console.log(`Release masters checked: ${all.length}`);
console.log(`Needing a signature update: ${stale.length}`);

let filled = 0;
let resynced = 0;
let skipped = 0;

for (const doc of stale) {
  const label = `${doc.skuId || "(no SKU id)"} / ${doc.vendorName || "(no vendor)"} (_id ${doc._id})`;
  const signature = buildReleaseSignature(doc);
  const wasMissing = !doc.releaseSignature;

  const collision = await ReleaseMaster.findOne({ releaseSignature: signature, _id: { $ne: doc._id } })
    .select("_id skuId vendorName")
    .lean();
  if (collision) {
    console.log(`SKIP     ${label} -- would collide with ${collision.skuId} (_id ${collision._id}); resolve manually.`);
    skipped++;
    continue;
  }

  console.log(`${wasMissing ? "FILL   " : "RESYNC "}  ${label}`);
  if (APPLY) await ReleaseMaster.updateOne({ _id: doc._id }, { $set: { releaseSignature: signature } });
  if (wasMissing) filled++;
  else resynced++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled (was missing):     ${filled}`);
console.log(`Resynced (stale formula): ${resynced}`);
console.log(`Skipped (collision):      ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await ReleaseMaster.db.close();
process.exit(0);
