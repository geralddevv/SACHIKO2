import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import SachikoSL from "../../models/sachiko/sachikoSL.js";

// ---------------------------------------------------------------------------
// One-time backfill for SachikoSL.skuCode -- added as a required, unique
// field after SL records already existed. Format mirrors the Tape master's
// Product ID: `FS | SL | 000001`.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-sl-sku-code.js           # preview
//   node scripts/backfill-sl-sku-code.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

const formatSkuCode = (n) => `FS | SL | ${String(n).padStart(6, "0")}`;
const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

await connectDB();

const missing = await SachikoSL.find({ $or: [{ skuCode: { $exists: false } }, { skuCode: "" }] })
  .sort({ createdAt: 1 })
  .lean();

console.log(`SL records missing skuCode: ${missing.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let nextSeq = parseSkuSeq(
  (await SachikoSL.findOne({ skuCode: { $exists: true, $ne: "" } }).sort({ skuCode: -1 }).select("skuCode").lean())?.skuCode,
) + 1;

for (const doc of missing) {
  let candidate = formatSkuCode(nextSeq);
  while (await SachikoSL.exists({ skuCode: candidate })) {
    nextSeq += 1;
    candidate = formatSkuCode(nextSeq);
  }

  console.log(`FILL     ${doc.productCode || "(no product code)"} (_id ${doc._id})`);
  console.log(`           -> "${candidate}"`);
  if (APPLY) await SachikoSL.updateOne({ _id: doc._id }, { $set: { skuCode: candidate } });
  nextSeq += 1;
}

console.log(APPLY ? "\nChanges committed." : "\nDry-run only. Re-run with --apply to commit.");

await SachikoSL.db.close();
process.exit(0);
