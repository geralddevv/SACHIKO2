import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStock from "../models/inventory/materialStock.js";
import SlittingJobCard from "../models/inventory/slittingJobCard.js";

// ---------------------------------------------------------------------------
// Clear the "waiting" rows off the Slitting Queue (/slitting/queue).
//
// Those rows are deckle batches that carry a slitting layout but have not been
// run: no machine, no Deckle ever laminated for them. They sit on the queue
// (buildPlannedDeckleGroups) -- and on the Deckle Queue -- until someone
// dissolves them. This does exactly what the Deckle Queue's Dissolve button
// does (POST /labels/production/deckle-batch/:id/dissolve): the batch row is
// deleted, its member orders are unbatched and go back to Deckle Sorting, and
// any remainder rows split off at batching are folded back into their orders.
// No order is deleted.
//
// Only a batch that is provably untouched is eligible; anything else is listed
// and refused: assigned to a machine, any Deckle made for it, raw reels
// allotted, or a Slitting Job Card pointing at it.
//
// Dry-run by default; with no ids it just lists the eligible batches.
//
//   node scripts/dissolve-waiting-deckle-batches.js                 # list
//   node scripts/dissolve-waiting-deckle-batches.js --all           # preview all eligible
//   node scripts/dissolve-waiting-deckle-batches.js <batchId> ...   # preview those
//   ... add --apply to commit (a JSON backup is written to scripts/backups/)
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

// Same population the Slitting Queue's waiting rows come from.
const batches = await PendingProduction.find({
  isDeckleBatch: true,
  deckleSize: { $ne: null },
  deckleBatchId: null,
  deckleOnly: { $ne: true },
}).lean();

const eligible = [];
for (const b of batches) {
  const members = await PendingProduction.find({ deckleBatchId: b._id }).select("_id poNumber paperSize quantity noOfRolls").lean();
  const deckles = await MaterialStock.countDocuments({ producedFor: b._id });
  const cards = await SlittingJobCard.countDocuments({ pendingProductionId: b._id });
  const why = [];
  if (b.assignedMachineId) why.push("assigned to a machine");
  if (b.producedAt) why.push("already produced");
  if (deckles) why.push(`${deckles} deckle(s) made`);
  if ((b.allottedRollIds || []).length) why.push("raw reels allotted");
  if (cards) why.push(`${cards} slitting card(s) reference it`);
  const layouts = (b.deckleLayout || []).map((l) => `${l.count}x ${(l.cuts || []).map((c) => c.width).join("+")}`).join(" | ");
  console.log(`${String(b._id)}  lot ${b.lotNo || "—"}  ${b.deckleSize}mm  deckles ${b.producedRolls || 0}/${b.noOfRolls}  layout ${layouts || "—"}`);
  for (const m of members) console.log(`    member ${m._id}  PO ${m.poNumber || "—"}  ${m.paperSize || "—"}  qty ${m.quantity}`);
  console.log(`    -> ${why.length ? "NOT ELIGIBLE: " + why.join("; ") : "eligible"}`);
  if (!why.length) eligible.push({ batch: b, members });
}

let chosen = ALL ? eligible : eligible.filter((e) => wanted.includes(String(e.batch._id)));
const unknown = wanted.filter((id) => !batches.some((b) => String(b._id) === id));
const refused = wanted.filter((id) => batches.some((b) => String(b._id) === id) && !eligible.some((e) => String(e.batch._id) === id));
if (unknown.length || refused.length) {
  console.error(`\nREFUSED -- not eligible / not found: ${[...unknown, ...refused].join(", ")}. Nothing changed.`);
  process.exit(1);
}
if (!chosen.length) {
  console.log("\nNothing selected. Pass --all or batch ids.");
  process.exit(0);
}
if (!APPLY) {
  console.log(`\nWould dissolve ${chosen.length} batch(es); members return to Deckle Sorting. Re-run with --apply.`);
  process.exit(0);
}

fs.mkdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "backups"), { recursive: true });
const bk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "backups", `waiting-deckle-batches-${Date.now()}.json`);
fs.writeFileSync(bk, JSON.stringify(chosen.map((e) => e.batch), null, 1));
console.log(`\nBackup written: ${bk}`);

for (const { batch, members } of chosen) {
  await PendingProduction.updateMany({ deckleBatchId: batch._id }, { $unset: { deckleBatchId: "", deckleSize: "" } });
  await PendingProduction.deleteOne({ _id: batch._id });
  // Fold back remainder rows split off at batching (same as the Dissolve route).
  for (const m of members) {
    const spare = await PendingProduction.find({ parentOrderId: m._id, deckleBatchId: null, assignedMachineId: null })
      .select("_id quantity noOfRolls").lean();
    if (!spare.length) continue;
    const qty = spare.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    const rolls = spare.reduce((n, r) => n + (Number(r.noOfRolls) || 0), 0);
    await PendingProduction.updateOne({ _id: m._id }, { $inc: { quantity: qty, ...(rolls ? { noOfRolls: rolls } : {}) } });
    await PendingProduction.deleteMany({ _id: { $in: spare.map((r) => r._id) } });
    console.log(`  folded ${spare.length} remainder row(s) back into ${m._id}`);
  }
  console.log(`DISSOLVED ${batch._id} (${members.length} member order(s) back on Deckle Sorting)`);
}
process.exit(0);
