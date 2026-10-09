import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";

// One-off: RELEASE/26-27/131 was keyed as a duplicate of 125. Delete 131 and
// give 125 its kg (382). Refuses to delete 131 if anything else references it.
//
//   node scripts/fix-releaseliner-125-131.js           # preview
//   node scripts/fix-releaseliner-125-131.js --apply   # commit

const APPLY = process.argv.includes("--apply");
// also sets quantity 1 -- the stock page hides reels with quantity 0
const KEEP = "RELEASE/26-27/125", DROP = "RELEASE/26-27/131", KG = 382;

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

const keep = await ReleaseLinerStock.findOne({ rollId: KEEP });
const drop = await ReleaseLinerStock.findOne({ rollId: DROP });
if (!keep) { console.log(`${KEEP} not found.`); process.exit(1); }
if (!drop) { console.log(`${DROP} not found (already deleted?).`); process.exit(1); }

const refs = await ReleaseLinerStock.db.collection("releaselinerstocklogs").countDocuments({ rollId: DROP });
if (refs) { console.log(`${DROP} has ${refs} log entries; resolve manually.`); process.exit(1); }

console.log(`${KEEP}: reelMtrs ${keep.reelMtrs} -> ${KG}`);
console.log(`${DROP}: delete`);
if (APPLY) {
  await ReleaseLinerStock.updateOne({ _id: keep._id }, { $set: { reelMtrs: KG, quantity: 1 } });
  await ReleaseLinerStock.deleteOne({ _id: drop._id });
  // The PART USED tag comes from the job card's releaseUsage line for this reel.
  await ReleaseLinerStock.db.collection("machinejobcards").updateMany(
    { "releaseUsage.stockId": keep._id },
    { $pull: { releaseUsage: { stockId: keep._id } } },
  );
  console.log("Changes committed.");
}
process.exit(0);
