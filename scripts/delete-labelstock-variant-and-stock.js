import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import FinishedStock from "../models/inventory/finishedStock.js";
import PendingProduction from "../models/inventory/pendingProduction.js";

// ---------------------------------------------------------------------------
// Deletes one or more Label Stock VARIANTS (never a plain base code) PLUS
// every physical Deckle reel (MaterialStock) each one has in Semi Finished
// Stock and their MaterialStockLog history -- a deliberate, complete
// removal, not just the SKU. scripts/remove-c011wb-labelstock-variants.js
// (generalize that one the same way if needed) refuses this exact case
// because that stock is real; this script is the explicit "yes, take the
// stock too" follow-up, for when that's actually what's wanted.
//
// Only ever touches rows shaped like "<CODE>-<LETTERS>" (e.g. C011WB-B) --
// a bare base code (e.g. C011WB) is never deleted, even if passed in.
//
//   node scripts/delete-labelstock-variant-and-stock.js <code>
//
// <code> is either:
//   - one exact variant Product Code (e.g. C011WB-B) -> targets just that row
//   - a base Product Code (e.g. C011WB) -> targets EVERY "-X" variant under
//     it (C011WB-A, C011WB-B, ...); the base row itself is left alone
//
// Before deleting anything for a given row, it checks two more places a
// MaterialStock reel can be referenced from:
//   - FinishedStock.deckleStockId -- a roll already slit from one of these Deckles
//   - PendingProduction.allottedRollIds -- an order still holding one allotted
// A row that fails this check is skipped (reported, not deleted) -- it does
// not stop the other targeted rows from being processed.
//
// Dry-run by default:
//   node scripts/delete-labelstock-variant-and-stock.js <code>
//
// Apply (permanently deletes every safe target + its reels + their logs):
//   node scripts/delete-labelstock-variant-and-stock.js <code> --apply
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const codeArg = process.argv.find((a, i) => i >= 2 && a !== "--apply");
const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "uploads", "sachiko", "label_stock");

if (!codeArg) {
  console.error("Usage: node scripts/delete-labelstock-variant-and-stock.js <productCode|baseCode> [--apply]");
  console.error("  e.g. node scripts/delete-labelstock-variant-and-stock.js C011WB-B");
  console.error("       node scripts/delete-labelstock-variant-and-stock.js C011WB        (every variant of C011WB)");
  process.exit(1);
}

const CODE = codeArg.trim().toUpperCase();
const VARIANT_SUFFIX = /-[A-Z]+$/;

async function processRow(labelStock) {
  console.log(`\n=== ${labelStock.productCode} / ${labelStock.skuCode} / ${labelStock.labelStockId} (_id ${labelStock._id}) ===`);

  const reels = await MaterialStock.find({ material: labelStock._id }).lean();
  console.log(`MaterialStock reels (${reels.length}):`);
  reels.forEach((r) => console.log(`  ${r.rollId} | reelMtrs=${r.reelMtrs} | qty=${r.quantity} (_id ${r._id})`));

  const reelIds = reels.map((r) => r._id);

  const logs = reelIds.length
    ? await MaterialStockLog.find({ $or: [{ material: labelStock._id }, { rollId: { $in: reels.map((r) => r.rollId) } }] }).lean()
    : [];
  console.log(`MaterialStockLog entries (${logs.length}).`);

  // Safety: make sure none of these reels have been slit into finished
  // rolls, or are still allotted to an open order, before deleting them.
  const finishedRefs = reelIds.length
    ? await FinishedStock.find({ deckleStockId: { $in: reelIds } }).select("deckleStockId deckleRollId").lean()
    : [];
  const pendingRefs = reelIds.length
    ? await PendingProduction.find({ allottedRollIds: { $in: reelIds } }).select("poNumber").lean()
    : [];

  if (finishedRefs.length || pendingRefs.length) {
    console.error(`[SKIPPED] ${labelStock.productCode} -- reels still referenced elsewhere:`);
    if (finishedRefs.length) console.error(`  FinishedStock (already slit into rolls): ${finishedRefs.length} doc(s)`);
    if (pendingRefs.length) console.error(`  PendingProduction (still allotted to an order): ${pendingRefs.length} doc(s)`);
    return { skipped: true };
  }

  console.log(`No downstream references -- safe to proceed.`);

  if (!APPLY) {
    return { skipped: false, preview: { reels: reels.length, logs: logs.length } };
  }

  if (logs.length) {
    const res = await MaterialStockLog.deleteMany({ _id: { $in: logs.map((l) => l._id) } });
    console.log(`  ✓ Removed ${res.deletedCount} MaterialStockLog entr(y/ies)`);
  }
  if (reelIds.length) {
    const res = await MaterialStock.deleteMany({ _id: { $in: reelIds } });
    console.log(`  ✓ Removed ${res.deletedCount} MaterialStock reel(s)`);
  }
  await SachikoLabelStock.deleteOne({ _id: labelStock._id });
  if (labelStock.wordFile) {
    const filePath = path.join(UPLOAD_DIR, labelStock.wordFile);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.warn(`  Could not remove file ${labelStock.wordFile}: ${e.message}`); }
    }
  }
  console.log(`  ✓ Removed ${labelStock.productCode} (Label Stock row)`);
  return { skipped: false };
}

try {
  await connectDB();
  console.log(`Mode: ${APPLY ? "APPLY (permanently deleting)" : "DRY-RUN (no changes)"}`);
  console.log(`Target code: ${CODE}`);

  let targets;
  if (VARIANT_SUFFIX.test(CODE)) {
    // Passed an exact variant code -- target just that one row.
    const doc = await SachikoLabelStock.findOne({ productCode: CODE }).lean();
    targets = doc ? [doc] : [];
  } else {
    // Passed a base code -- target every "-X" variant under it. The base
    // row itself is deliberately excluded, never deleted by this script.
    targets = await SachikoLabelStock.find({ productCode: new RegExp(`^${CODE}-[A-Z]+$`, "i") })
      .sort({ productCode: 1 })
      .lean();
  }

  if (!targets.length) {
    console.log(`\nNo variant row(s) found for "${CODE}" -- nothing to do.`);
    process.exit(0);
  }
  console.log(`Found ${targets.length} variant row(s) to process.`);

  let removed = 0;
  let skipped = 0;
  for (const doc of targets) {
    const result = await processRow(doc);
    if (result.skipped) skipped += 1;
    else removed += 1;
  }

  console.log(`\n---`);
  if (!APPLY) {
    console.log(`Dry-run complete. ${removed} row(s) would be removed (with their reels + logs), ${skipped} skipped (blocked).`);
    if (removed) console.log("Re-run with --apply to commit.");
  } else {
    console.log(`Done. ${removed} row(s) removed, ${skipped} skipped (blocked).`);
  }
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
