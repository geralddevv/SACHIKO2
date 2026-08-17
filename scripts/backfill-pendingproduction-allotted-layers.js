import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import { requiredLayersFor, LAYER_META, POOL_MODELS } from "../utils/labelStockProduction.js";

// ---------------------------------------------------------------------------
// Backfill for PendingProduction.allottedLayers -- added so the machine queue
// (routes/system/machine.js's buildQueueRows, views/inventory/masters/
// machineQueue.ejs's "Material Allocation" section) can show which raw-
// material reel/drum was picked per recipe layer (Facestock/Adhesive/Release
// Liner, ...), instead of only the finished Deckle count.
//
// Orders assigned before that field existed have no allottedLayers, even
// though a Deckle may already have been laminated for them -- produceDeckle()
// (utils/labelStockProduction.js) writes the raw rollIds it consumed into the
// Deckle's own INWARD MaterialStockLog remarks ("Produced from A, B, C"), in
// exactly the order it walked requiredLayersFor(rollType) -- so that remarks
// string can be zipped back against the same required-layer list to recover
// which rollId belonged to which layer, then resolved to a stockId in the
// right pool model (FacestockStock/AdhesiveStock/ReleaseLinerStock).
//
// Orders with no produced Deckle (short-allotted, nothing ever laminated)
// have no such log line and are left alone -- there's nothing to recover,
// they were genuinely never allocated.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-pendingproduction-allotted-layers.js           # preview
//   node scripts/backfill-pendingproduction-allotted-layers.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const rows = await PendingProduction.find({
  allottedRollIds: { $exists: true, $not: { $size: 0 } },
  $or: [{ allottedLayers: { $exists: false } }, { allottedLayers: {} }],
})
  .select("_id lotNo itemId allottedRollIds")
  .populate({ path: "itemId", select: "productCode skuCode rollType" })
  .lean();

console.log(`WIP orders with a produced Deckle but no allottedLayers: ${rows.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let backfilled = 0;
let skippedNoLog = 0;
let skippedMismatch = 0;
let skippedUnresolved = 0;

for (const p of rows) {
  const item = p.itemId;
  const label = `${item?.productCode || item?.skuCode || "(no product code)"} / lot ${p.lotNo || "—"} (_id ${p._id})`;
  if (!item) {
    console.log(`SKIP     ${label} -- item no longer exists`);
    continue;
  }

  const required = requiredLayersFor(item.rollType);

  // Find the Deckle's own INWARD log line among this order's allotted rolls
  // -- it's the one whose remarks record what it was laminated from.
  const log = await MaterialStockLog.findOne({
    material: item._id,
    rollId: { $in: p.allottedRollIds },
    type: "INWARD",
    remarks: /^Produced from /,
  })
    .select("remarks")
    .lean();

  if (!log) {
    skippedNoLog++;
    console.log(`SKIP     ${label} -- no "Produced from" log found (nothing laminated yet)`);
    continue;
  }

  const rawRollIds = log.remarks
    .replace(/^Produced from /, "")
    .replace(/ -- reel emptied$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawRollIds.length !== required.length) {
    skippedMismatch++;
    console.log(`SKIP     ${label} -- ${rawRollIds.length} rollIds logged but recipe needs ${required.length} (rollType may have changed since)`);
    continue;
  }

  const allottedLayers = {};
  let unresolved = false;
  for (let i = 0; i < required.length; i++) {
    const layerKey = required[i];
    const meta = LAYER_META[layerKey];
    const { Model } = POOL_MODELS[meta.pool];
    const doc = await Model.findOne({ rollId: rawRollIds[i] }).select("_id").lean();
    if (!doc) {
      unresolved = true;
      break;
    }
    allottedLayers[layerKey] = { pool: meta.pool, stockIds: [String(doc._id)] };
  }

  if (unresolved) {
    skippedUnresolved++;
    console.log(`SKIP     ${label} -- a logged rollId no longer exists in its pool (reel deleted since)`);
    continue;
  }

  console.log(`BACKFILL ${label}`);
  console.log(`           -> ${Object.entries(allottedLayers).map(([k, v]) => `${k}: ${v.stockIds.join("+")}`).join(", ")}`);

  if (APPLY) {
    await PendingProduction.updateOne({ _id: p._id }, { $set: { allottedLayers } });
  }
  backfilled++;
}

console.log(`\n--- Summary ---`);
console.log(`Backfilled:          ${backfilled}`);
console.log(`No production log:   ${skippedNoLog}`);
console.log(`Recipe mismatch:     ${skippedMismatch}`);
console.log(`Unresolved reel:     ${skippedUnresolved}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await PendingProduction.db.close();
process.exit(0);
