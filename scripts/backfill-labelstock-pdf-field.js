import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// SachikoLabelStock used to have one attachment slot, `wordFile`, that
// accepted both Word (.doc/.docx) and PDF uploads (see CLAUDE.md). It's now
// split into `wordFile` (Word only) and `pdfFile` (PDF only) -- see the
// schema comment in models/sachiko/sachikoLabelStock.js.
//
// This moves every row whose existing wordFile ends in .pdf over to the new
// pdfFile field (nothing on disk moves -- same filename, just a different DB
// field), so it shows up under "PDF File" instead of "Word File" in
// views/sachiko/labelStockView.ejs.
//
// It also reports, for every row with either field set, whether the file it
// names actually exists in uploads/sachiko/labelstocks/ -- a row pointing at
// a file that isn't there is what makes an "uploaded" attachment un-openable
// (GET /sachiko/label-stock/file/:filename 404s). This script can't recover
// a missing file's bytes; it can only tell you which rows are affected.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-labelstock-pdf-field.js           # preview
//   node scripts/backfill-labelstock-pdf-field.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const UPLOAD_DIR = path.resolve("uploads/sachiko/labelstocks");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await SachikoLabelStock.find().select("productCode skuCode wordFile wordFileOriginalName pdfFile pdfFileOriginalName").lean();

const toMove = all.filter((doc) => doc.wordFile && path.extname(doc.wordFile).toLowerCase() === ".pdf");

console.log(`Label Stocks checked: ${all.length}`);
console.log(`wordFile rows that are actually PDFs (need to move to pdfFile): ${toMove.length}\n`);

for (const doc of toMove) {
  const label = `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} (_id ${doc._id})`;
  console.log(`MOVE     ${label} -- wordFile "${doc.wordFile}" -> pdfFile`);
  if (APPLY) {
    await SachikoLabelStock.updateOne(
      { _id: doc._id },
      {
        $set: { pdfFile: doc.wordFile, pdfFileOriginalName: doc.wordFileOriginalName },
        $unset: { wordFile: "", wordFileOriginalName: "" },
      },
    );
  }
}

console.log(`\n--- File presence check (uploads/sachiko/labelstocks/) ---`);
const afterMove = APPLY
  ? await SachikoLabelStock.find().select("productCode skuCode wordFile pdfFile").lean()
  : all.map((doc) => (toMove.some((m) => String(m._id) === String(doc._id)) ? { ...doc, pdfFile: doc.wordFile, wordFile: undefined } : doc));

let missing = 0;
for (const doc of afterMove) {
  for (const field of ["wordFile", "pdfFile"]) {
    const filename = doc[field];
    if (!filename) continue;
    const exists = fs.existsSync(path.join(UPLOAD_DIR, filename));
    if (!exists) {
      missing++;
      console.log(`MISSING  ${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} -- ${field} "${filename}" is not on disk`);
    }
  }
}
if (!missing) console.log("All attached files are present on disk.");

console.log(`\n--- Summary ---`);
console.log(`Moved wordFile -> pdfFile: ${toMove.length}`);
console.log(`Rows pointing at a missing file: ${missing}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
