import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";

// ---------------------------------------------------------------------------
// Backfill for ReleaseLinerStock.sensing.
//
// Sensing is now the ONE field a Label Stock recipe's Release Liner layer is
// matched on (utils/labelStockProduction.js's POOL_MATCH_FIELDS), but it only
// started being recorded on a reel once that field was added to the stock
// schema -- inward copies it off the Release Master being inwarded against.
// Every reel entered before that has none, and a reel with none can never
// match a recipe that asks for SENSING or NON-SENSING: it would silently
// vanish from the Assign Production picker. This fills it in from the master
// each reel was entered against.
//
// A reel is tied back to its master by exactly the fields the stock schema
// mirrors from it (vendor/type/make/vendor SKU code/color/size/gsm) -- the
// same grouping routes/stock/releaseLinerStock.js's releaseSpecKey() uses to
// put a reel in its master's bucket on the stock page.
//
// Left alone and reported rather than guessed at:
//   - a reel matching no master at all (its spec was edited or deleted since)
//   - a reel matching masters that disagree about sensing (two masters differ
//     only by that field -- which of the two the reel is, nobody here knows)
//   - a master whose own sensing is blank (nothing to copy)
// Reels that already carry a sensing value are never touched.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-releaselinerstock-sensing.js           # preview
//   node scripts/backfill-releaselinerstock-sensing.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

// Must stay in step with releaseSpecKey() in routes/stock/releaseLinerStock.js.
function releaseSpecKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const n = (v) => (v === undefined || v === null || v === "" ? "" : String(Number(v)));
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.vendorSkuCode), s(o.color), s(o.size), n(o.gsm)].join("||");
}

async function run() {
  await connectDB();

  const masters = await ReleaseMaster.find().lean();

  // key -> Set of the sensing values the masters under that key hold. More
  // than one value means the key can't decide the question on its own.
  const sensingByKey = new Map();
  for (const m of masters) {
    const key = releaseSpecKey(m);
    if (!sensingByKey.has(key)) sensingByKey.set(key, new Set());
    sensingByKey.get(key).add(String(m.sensing || "").trim().toUpperCase());
  }

  const reels = await ReleaseLinerStock.find({
    $or: [{ sensing: { $exists: false } }, { sensing: "" }, { sensing: null }],
  }).lean();

  const updates = [];
  const noMaster = [];
  const ambiguous = [];
  const masterBlank = [];

  for (const reel of reels) {
    const values = sensingByKey.get(releaseSpecKey(reel));
    if (!values) {
      noMaster.push(reel);
      continue;
    }
    const usable = [...values].filter(Boolean);
    if (usable.length === 0) {
      masterBlank.push(reel);
      continue;
    }
    if (usable.length > 1) {
      ambiguous.push({ reel, values: usable });
      continue;
    }
    updates.push({ reel, sensing: usable[0] });
  }

  console.log(`Release liner reels with no sensing recorded: ${reels.length}`);
  console.log(`  resolvable from their master : ${updates.length}`);
  console.log(`  master has no sensing set    : ${masterBlank.length}`);
  console.log(`  no matching master           : ${noMaster.length}`);
  console.log(`  masters disagree on sensing  : ${ambiguous.length}`);

  for (const { reel, sensing } of updates) {
    console.log(`  ${APPLY ? "SET " : "would set"} ${reel.rollId} -> ${sensing}`);
  }
  for (const reel of masterBlank) console.log(`  SKIP ${reel.rollId} -- its master has no Sensing filled in`);
  for (const reel of noMaster) console.log(`  SKIP ${reel.rollId} -- no Release Master matches its spec`);
  for (const { reel, values } of ambiguous) {
    console.log(`  SKIP ${reel.rollId} -- masters disagree: ${values.join(" / ")}`);
  }

  if (!APPLY) {
    console.log("\nDry run -- nothing written. Re-run with --apply to commit.");
  } else if (updates.length) {
    const result = await ReleaseLinerStock.bulkWrite(
      updates.map(({ reel, sensing }) => ({
        updateOne: { filter: { _id: reel._id }, update: { $set: { sensing } } },
      })),
    );
    console.log(`\nUpdated ${result.modifiedCount} reel(s).`);
  } else {
    console.log("\nNothing to update.");
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("BACKFILL RELEASE LINER SENSING ERROR:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
