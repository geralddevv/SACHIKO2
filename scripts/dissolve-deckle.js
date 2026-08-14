import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import { dissolveDeckle } from "../utils/labelStockProduction.js";

// Un-makes a Deckle by hand: returns its mtrs to the facestock/adhesive/
// release liner reels it was laminated from and deletes the reel, writing the
// matching ledger lines both sides. The same reversal sending a WIP order back
// to Pending now runs automatically (routes/fairdesk_route.js's POST
// /labels/production/unassign/:id) -- this exists for the Deckles left orphaned
// by a revert done *before* that existed, which have no producedFor stamp for
// the route to find them by.
//
// Refuses any Deckle that is still allotted to a machine-assigned order (send
// that order back to Pending instead) or that has already been drawn from.
//
// Usage:
//   node scripts/dissolve-deckle.js                      # list orphan candidates
//   node scripts/dissolve-deckle.js C011/26-27/001       # dry run
//   node scripts/dissolve-deckle.js C011/26-27/001 --apply

const args = process.argv.slice(2).filter((a) => a !== "--apply");
const apply = process.argv.includes("--apply");
const target = args[0];

await connectDB();

if (!target) {
  const reels = await MaterialStock.find().select("rollId reelMtrs quantity location").sort({ rollId: 1 }).lean();
  if (!reels.length) {
    console.log("No Deckle reels in stock.");
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log("Deckle reels in stock:\n");
  for (const r of reels) {
    const claimed = await PendingProduction.findOne({
      allottedRollIds: r._id,
      assignedMachineId: { $ne: null },
    }).select("lotNo").lean();
    const inward = await MaterialStockLog.findOne({
      rollId: r.rollId,
      type: "INWARD",
      remarks: /^Produced from /,
    }).select("remarks reelMtrs").lean();
    const state = claimed
      ? `held by ${claimed.lotNo} -- send that order back to Pending instead`
      : !inward
      ? "no lamination record -- cannot be dissolved"
      : Number(r.quantity) !== 1 || Number(r.reelMtrs) !== Number(inward.reelMtrs)
      ? `already used (${r.reelMtrs} of ${inward.reelMtrs} mtrs left) -- cannot be dissolved`
      : "CAN BE DISSOLVED";
    console.log(`  ${r.rollId}  ${r.reelMtrs} m  qty ${r.quantity}  @${r.location}`);
    console.log(`      ${inward?.remarks || "(no lamination record)"}`);
    console.log(`      -> ${state}\n`);
  }
  console.log("Pass a Deckle ID to dissolve it, then --apply to commit.");
  await mongoose.disconnect();
  process.exit(0);
}

const rollId = target.trim().toUpperCase();
const deckle = await MaterialStock.findOne({ rollId }).lean();
if (!deckle) {
  console.error(`Deckle "${rollId}" not found.`);
  await mongoose.disconnect();
  process.exit(1);
}

const claimed = await PendingProduction.findOne({
  allottedRollIds: deckle._id,
  assignedMachineId: { $ne: null },
}).select("lotNo").lean();
if (claimed) {
  console.error(
    `Deckle ${rollId} is still allotted to ${claimed.lotNo}. Send that order back to Pending instead -- it returns the material itself.`,
  );
  await mongoose.disconnect();
  process.exit(1);
}

const inward = await MaterialStockLog.findOne({
  rollId,
  type: "INWARD",
  remarks: /^Produced from /,
}).select("remarks reelMtrs").lean();

console.log(`Deckle      ${rollId}`);
console.log(`Mtrs        ${deckle.reelMtrs} (laminated at ${inward?.reelMtrs ?? "?"})`);
console.log(`Location    ${deckle.location}`);
console.log(`Lamination  ${inward?.remarks || "(none -- cannot be dissolved)"}`);
console.log();

if (!apply) {
  console.log("DRY RUN -- nothing written. Re-run with --apply to return this material and delete the reel.");
  await mongoose.disconnect();
  process.exit(0);
}

try {
  const result = await dissolveDeckle({ stockId: deckle._id, createdBy: "SCRIPT" });
  console.log(`Dissolved ${result.deckleId} (${result.mtrs} mtrs).`);
  for (const r of result.restored) {
    console.log(`  returned ${r.mtrs} mtrs${r.rolls ? ` + ${r.rolls} roll(s)` : ""} to ${r.rollId}`);
  }
  for (const m of result.missing) {
    console.log(`  WARNING: source reel ${m} no longer exists -- its material could not be returned`);
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  await mongoose.disconnect();
  process.exit(1);
}

await mongoose.disconnect();
