import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStock from "../models/inventory/materialStock.js";

// ---------------------------------------------------------------------------
// Close out a job that is over but still sitting on a machine queue and the
// WIP tab.
//
// Both lists show every PendingProduction with an assigned machine and
// `producedAt: null`. Save Production Entry only stamps producedAt once the
// deckles produced reach the job's target, so a job whose card was saved short
// (or never saved) stays listed forever. This stamps producedAt -- the same
// thing the card save does on completion -- and clears the live punches
// (runningOn, liveRun, liveSetting, livePause, ...) so nothing keeps it
// "Running" / "In Setting". producedRolls is raised to the number of Deckles
// the Stop punches actually made for it (never lowered). Nothing else is touched: Deckles, reels, logs and
// the Lot No stay as they are.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/close-stale-job.js "SP | LOT | 0012"          # preview
//   node scripts/close-stale-job.js "SP | LOT | 0012" --apply  # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const lotNo = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!lotNo) {
  console.error('Usage: node scripts/close-stale-job.js "<Lot No>" [--apply]');
  process.exit(1);
}

await connectDB();

// Tolerate spacing differences in how the Lot No is typed.
const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
const candidates = await PendingProduction.find({ lotNo: { $exists: true, $ne: "" } })
  .select("lotNo assignedMachineId producedAt producedRolls noOfRolls quantity isDeckleBatch runningOn liveRun liveSetting livePause liveStartedAt liveMaterialInUse")
  .lean();
const rows = candidates.filter((p) => norm(p.lotNo) === norm(lotNo));

console.log(`Lot No "${lotNo}": ${rows.length} order(s) found`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

for (const p of rows) {
  const target = p.isDeckleBatch ? p.noOfRolls : p.quantity;
  console.log(
    `${p._id}  lot ${p.lotNo}  machine ${p.assignedMachineId || "—"}  produced ${p.producedRolls || 0}/${target ?? "?"}` +
      `  producedAt ${p.producedAt ? p.producedAt.toISOString() : "null"}`,
  );
  if (p.producedAt) {
    console.log("  SKIP -- already closed (producedAt set); it is not what keeps it listed.");
    continue;
  }
  const made = await MaterialStock.countDocuments({ producedFor: p._id, producedVia: "jobcard" });
  const producedRolls = Math.max(Number(p.producedRolls) || 0, made);
  console.log(`  Deckles made by Stop punches: ${made} -> producedRolls ${producedRolls}`);
  if (!APPLY) {
    console.log("  would set producedAt = now and clear live fields");
    continue;
  }
  const res = await PendingProduction.updateOne(
    { _id: p._id, producedAt: null },
    {
      $set: { producedAt: new Date(), producedRolls },
      $unset: {
        runningOn: "", liveMaterialInUse: "", liveRun: "", liveSetting: "",
        liveStartedAt: "", livePause: "", livePauseLog: "",
      },
    },
  );
  console.log(res.modifiedCount ? "  CLOSED" : "  unchanged (changed under us)");
}

if (!APPLY && rows.length) console.log("\nRe-run with --apply to commit.");
process.exit(0);
