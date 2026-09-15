import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import FinishedStock from "../models/inventory/finishedStock.js";
import FinishedStockLog from "../models/inventory/finishedStockLog.js";
import PendingProduction from "../models/inventory/pendingProduction.js";

// ---------------------------------------------------------------------------
// Backfill for FinishedStock.rate on rolls produced by SLITTING.
//
// POST /slitting/jobcard/row/produce used to write `rate: reel.rate` onto each
// finished roll -- the DECKLE's rate. A Deckle is semi-finished stock: it
// carries a material cost at best, never a sale price, and on the job-card
// production path it carries nothing at all. So every roll slit before that
// was fixed landed on Finished Stock with a blank (or plain wrong) Rate.
//
// The rate a roll is actually worth is the rate its own SALES ORDER was placed
// at -- PendingProduction.orderRate, synced from the order (see
// utils/pendingProduction.js). A deckle batch bundles SEVERAL orders' widths
// onto one web (isDeckleBatch/batchOrderIds) and those orders can be at
// different rates, so this matches per roll WIDTH exactly as the route now
// does: exact width + R. Meter first, then width alone, then the card's own
// order.
//
// Only touches rolls that are slit-produced (deckleStockId set) AND have no
// rate. A roll already carrying one -- including one typed in by hand on the
// Finished Stock page -- is never overwritten. The matching INWARD ledger line
// (FinishedStockLog) is corrected alongside, so stock and ledger agree.
//
// Left alone and reported rather than guessed at:
//   - a roll whose order is gone, or whose width matches no member order
//   - a roll whose matched order has no rate of its own
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-finishedstock-rate.js           # preview
//   node scripts/backfill-finishedstock-rate.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sizeNum = (v) => {
  const m = /-?\d+(\.\d+)?/.exec(String(v ?? ""));
  return m ? Number(m[0]) : null;
};

// Every order that could price a roll made against `pendingId`: a deckle
// batch's member orders first, then the row itself. Cached -- one batch
// normally covers every roll in a run.
const sourceCache = new Map();
async function rateSourcesFor(pendingId) {
  const key = String(pendingId || "");
  if (!key) return [];
  if (sourceCache.has(key)) return sourceCache.get(key);

  const pending = await PendingProduction.findById(key)
    .select("orderRate paperSize runningMeters batchOrderIds")
    .lean();
  const sources = [];
  if (pending?.batchOrderIds?.length) {
    sources.push(
      ...(await PendingProduction.find({ _id: { $in: pending.batchOrderIds } })
        .select("orderRate paperSize runningMeters")
        .lean()),
    );
  }
  if (pending) sources.push(pending);

  const priced = sources.filter((s) => Number(s?.orderRate) > 0);
  sourceCache.set(key, priced);
  return priced;
}

async function run() {
  await connectDB();

  const rolls = await FinishedStock.find({
    deckleStockId: { $ne: null },
    $or: [{ rate: null }, { rate: { $exists: false } }],
  }).lean();

  const updates = [];
  const noOrder = [];
  const noMatch = [];

  for (const roll of rolls) {
    const priced = await rateSourcesFor(roll.pendingProductionId);
    if (!priced.length) {
      noOrder.push(roll);
      continue;
    }
    const w = sizeNum(roll.paperSize);
    const sameWidth = priced.filter((s) => sizeNum(s.paperSize) === w);
    const exact = sameWidth.find((s) => Number(s.runningMeters) === round2(roll.mtrs));
    const hit = exact || sameWidth[0];
    if (!hit) {
      noMatch.push(roll);
      continue;
    }
    updates.push({ roll, rate: Number(hit.orderRate), matchedOn: exact ? "width + R. Meter" : "width" });
  }

  console.log(`Slit-produced rolls with no rate : ${rolls.length}`);
  console.log(`  priceable from their order     : ${updates.length}`);
  console.log(`  order missing / has no rate    : ${noOrder.length}`);
  console.log(`  no member order at that width  : ${noMatch.length}`);

  for (const { roll, rate, matchedOn } of updates) {
    console.log(`  ${APPLY ? "SET " : "would set"} ${roll.rollId} (${roll.paperSize} mm) -> ${rate}   [${matchedOn}]`);
  }
  for (const roll of noOrder) console.log(`  SKIP ${roll.rollId} -- its order is gone or carries no rate`);
  for (const roll of noMatch) console.log(`  SKIP ${roll.rollId} -- no order on that batch ordered ${roll.paperSize} mm`);

  if (!APPLY) {
    console.log("\nDry run -- nothing written. Re-run with --apply to commit.");
  } else if (updates.length) {
    const stock = await FinishedStock.bulkWrite(
      updates.map(({ roll, rate }) => ({
        updateOne: { filter: { _id: roll._id }, update: { $set: { rate } } },
      })),
    );
    // The ledger line for the same roll's INWARD carried the same wrong rate.
    const ledger = await FinishedStockLog.bulkWrite(
      updates.map(({ roll, rate }) => ({
        updateMany: {
          filter: { rollId: roll.rollId, type: "INWARD", $or: [{ rate: null }, { rate: { $exists: false } }] },
          update: { $set: { rate } },
        },
      })),
    );
    console.log(`\nUpdated ${stock.modifiedCount} roll(s) and ${ledger.modifiedCount} ledger line(s).`);
  } else {
    console.log("\nNothing to update.");
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("BACKFILL FINISHED STOCK RATE ERROR:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
