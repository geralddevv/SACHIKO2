import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import { POOL_MODELS } from "../utils/labelStockProduction.js";

// ---------------------------------------------------------------------------
// Completely remove a deckle-batch job by Lot No: the batch row itself, every
// Deckle its Stop punches made, and those Deckles' ledger lines.
//
// Meant for a job that was run but whose Job Card was never saved. In that
// state a Stop punch has minted the Deckle but the raw reels were NEVER
// deducted (that only happens when the card is saved), so there is nothing to
// give back -- the script verifies this and refuses otherwise.
//
// The orders the batch was cut from are NOT deleted: they are unbatched and
// return to Deckle Sorting, exactly as Dissolve does. The Label Stock master
// (incl. any -A/-B variant the run created) and the Lot counter are left alone.
//
// Refuses (touches nothing) if any Deckle has been drawn from / slit, is
// allotted to another order, or has raw-material OUTWARD lines ("allocated to
// Deckle ...") -- use scripts/dissolve-deckle.js for those.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/delete-deckle-batch-job.js "SP | LOT | 0012"          # preview
//   node scripts/delete-deckle-batch-job.js "SP | LOT | 0012" --apply  # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const lotNo = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!lotNo) {
  console.error('Usage: node scripts/delete-deckle-batch-job.js "<Lot No>" [--apply]');
  process.exit(1);
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const all = await PendingProduction.find({ lotNo: { $exists: true, $ne: "" } }).lean();
const batches = all.filter((p) => norm(p.lotNo) === norm(lotNo));
if (batches.length !== 1) {
  console.error(`Expected exactly 1 order with Lot No "${lotNo}", found ${batches.length}. Nothing done.`);
  process.exit(1);
}
const batch = batches[0];
if (!batch.isDeckleBatch) {
  console.error(`${batch._id} is not a deckle batch (isDeckleBatch false). Nothing done.`);
  process.exit(1);
}

const members = await PendingProduction.find({ deckleBatchId: batch._id }).select("_id poNumber paperSize quantity").lean();
const deckles = await MaterialStock.find({ producedFor: batch._id }).lean();
const problems = [];

console.log(`Batch ${batch._id}  lot ${batch.lotNo}  machine ${batch.assignedMachineId || "—"}`);
console.log(`Member orders (kept, returned to Deckle Sorting): ${members.length}`);
for (const m of members) console.log(`  ${m._id}  PO ${m.poNumber}  ${m.paperSize}  qty ${m.quantity}`);
console.log(`Deckles to delete: ${deckles.length}`);

for (const d of deckles) {
  const logs = await MaterialStockLog.find({ rollId: d.rollId }).lean();
  const inward = logs.find((l) => l.type === "INWARD");
  console.log(`  ${d.rollId}  ${d.reelMtrs} m  qty ${d.quantity}  slitRuns ${d.slitRunCount || 0}  ledger lines ${logs.length}`);
  if (Number(d.quantity) !== 1 || (inward && Number(d.reelMtrs) !== Number(inward.reelMtrs)) || Number(d.slitRunCount) > 0) {
    problems.push(`${d.rollId} has already been used/slit`);
  }
  if (logs.some((l) => l.type !== "INWARD")) problems.push(`${d.rollId} has non-INWARD ledger lines`);
  const held = await PendingProduction.findOne({ allottedRollIds: d._id, _id: { $ne: batch._id } }).select("lotNo").lean();
  if (held) problems.push(`${d.rollId} is allotted to ${held.lotNo || held._id}`);
  const re = new RegExp(`allocated to Deckle ${escapeRegExp(d.rollId)}(?: --.*)?$`);
  for (const [pool, { LogModel }] of Object.entries(POOL_MODELS)) {
    const outs = await LogModel.countDocuments({ type: "OUTWARD", remarks: re });
    if (outs) problems.push(`${d.rollId} consumed raw material (${outs} ${pool} OUTWARD line(s)) -- use dissolve-deckle.js`);
  }
}
const stray = await MaterialStock.countDocuments({ lotNo: batch.lotNo, producedFor: { $ne: batch._id } });
if (stray) problems.push(`${stray} other Deckle(s) carry this Lot No but belong to another order`);

if (problems.length) {
  console.error("\nREFUSED -- nothing changed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\nWould delete the deckles + their ledger lines, unbatch the members, delete the batch row.");
  console.log("Re-run with --apply to commit.");
  process.exit(0);
}

const logDel = await MaterialStockLog.deleteMany({ rollId: { $in: deckles.map((d) => d.rollId) } });
const deckleDel = await MaterialStock.deleteMany({ _id: { $in: deckles.map((d) => d._id) } });
const unbatched = await PendingProduction.updateMany(
  { deckleBatchId: batch._id },
  { $unset: { deckleBatchId: "", deckleSize: "" } },
);
const batchDel = await PendingProduction.deleteOne({ _id: batch._id });
console.log(
  `\nDONE: ${deckleDel.deletedCount} deckle(s), ${logDel.deletedCount} ledger line(s), ` +
    `${unbatched.modifiedCount} member(s) unbatched, ${batchDel.deletedCount} batch row.`,
);
process.exit(0);
