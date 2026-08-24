import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// SachikoLabelStock.wordFile/pdfFile (see models/sachiko/sachikoLabelStock.js)
// name a file in uploads/sachiko/labelstocks/ -- GET /sachiko/label-stock/
// file/:filename (routes/sachiko/sachiko_route.js) serves it back, and the
// "Word File"/"PDF File" columns on /sachiko/label-stock/view render a
// "View" link whenever either field is set, with no check that the file is
// actually there.
//
// On this deployment's disk, every row's saved wordFile/pdfFile points at a
// file that doesn't exist -- uploaded through some other instance of this
// app sharing the same database, never carried over here. That makes the
// "View" link dead: a click 404s. This clears the stale field (and its
// *OriginalName companion) on any row whose file isn't found, so the column
// goes back to showing "--" instead of a link that doesn't work, on THIS
// deployment. It does not touch a row whose file genuinely is present.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-labelstock-clear-missing-files.js           # preview
//   node scripts/backfill-labelstock-clear-missing-files.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const UPLOAD_DIR = path.resolve("uploads/sachiko/labelstocks");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await SachikoLabelStock.find()
  .select("productCode skuCode wordFile wordFileOriginalName pdfFile pdfFileOriginalName")
  .lean();

console.log(`Label Stocks checked: ${all.length}\n`);

let cleared = 0;
for (const doc of all) {
  const label = `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} (_id ${doc._id})`;
  const unset = {};

  if (doc.wordFile && !fs.existsSync(path.join(UPLOAD_DIR, doc.wordFile))) {
    console.log(`CLEAR    ${label} -- wordFile "${doc.wordFile}" not on disk`);
    unset.wordFile = "";
    unset.wordFileOriginalName = "";
  }
  if (doc.pdfFile && !fs.existsSync(path.join(UPLOAD_DIR, doc.pdfFile))) {
    console.log(`CLEAR    ${label} -- pdfFile "${doc.pdfFile}" not on disk`);
    unset.pdfFile = "";
    unset.pdfFileOriginalName = "";
  }

  if (Object.keys(unset).length) {
    cleared++;
    if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $unset: unset });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Rows with a stale attachment cleared: ${cleared}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
