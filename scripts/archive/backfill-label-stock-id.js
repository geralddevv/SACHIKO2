import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import Counter from "../../models/system/counter.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// One-time backfill for SachikoLabelStock.labelStockId ("SKU ID" in the UI --
// see labelStockBindingEdit.ejs). The field is `required: true, unique: true`
// on the schema, but a record can still end up without one if it was written
// straight to the database (bypassing Mongoose validation) rather than
// through POST /sachiko/label-stock/form.
//
// Assigns ids from the exact same Counter key/format the live app uses
// (generateId("sachikoLabelStockId", "LS") in routes/sachiko/sachiko_route.js
// -> "SP | LS | 000001"), so the sequence continues cleanly and a record
// backfilled here is indistinguishable from one created normally.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-label-stock-id.js           # preview
//   node scripts/backfill-label-stock-id.js --apply   # commit
// ---------------------------------------------------------------------------

async function generateId(key, code) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | ${code} | ${String(counter.seq).padStart(6, "0")}`;
}

const APPLY = process.argv.includes("--apply");

await connectDB();

const missing = await SachikoLabelStock.find({
  $or: [{ labelStockId: { $exists: false } }, { labelStockId: null }, { labelStockId: "" }],
})
  .select("_id skuCode productCode")
  .lean();

console.log(`Label Stocks missing a SKU ID: ${missing.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let filled = 0;

for (const ls of missing) {
  const label = `${ls.productCode || "(no product code)"} / ${ls.skuCode || "(no sku code)"} (_id ${ls._id})`;

  if (!APPLY) {
    // Preview the id that would be assigned without consuming a sequence
    // number, so a dry-run can be re-run safely without skewing the counter.
    const counter = await Counter.findOne({ key: "sachikoLabelStockId" }).select("seq").lean();
    const nextSeq = Number(counter?.seq || 0) + 1 + filled;
    const preview = `SP | LS | ${String(nextSeq).padStart(6, "0")}`;
    console.log(`FILL     ${label}`);
    console.log(`           -> "${preview}"`);
    filled++;
    continue;
  }

  const labelStockId = await generateId("sachikoLabelStockId", "LS");
  await SachikoLabelStock.updateOne({ _id: ls._id }, { $set: { labelStockId } });
  console.log(`FILL     ${label}`);
  console.log(`           -> "${labelStockId}"`);
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
