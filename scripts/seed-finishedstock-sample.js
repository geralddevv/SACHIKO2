import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import FinishedStock from "../models/inventory/finishedStock.js";
import FinishedStockLog from "../models/inventory/finishedStockLog.js";
import MaterialStock from "../models/inventory/materialStock.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
// Registered here so the populate() calls below resolve -- a script has no
// server.js to load them through the routes.
import "../models/sachiko/sachikoLabelStock.js";
import "../models/users/username.js";
import { generateFinishedRollId } from "../utils/finishedRollId.js";

// ---------------------------------------------------------------------------
// Sample Finished Goods stock for /sachiko/finishedstock, so the page (and its
// Print Roll Label dialog) has something to show.
//
// Each sample roll is slit off a real Deckle still in stock and booked to a
// real client order of the same base Product Code, the way POST /create on
// the Finished Stock page would book it. Rolls get system roll IDs from
// generateFinishedRollId() and an INWARD ledger line each.
//
// What it deliberately does NOT do: take metres off the Deckles. The sample is
// added on top of semi-finished stock, not by consuming it, so the Deckle page
// keeps its figures. Every sample roll is marked in its remarks, and the script
// refuses to run again once they are there.
//
// Dry-run by default. Pass --apply to commit.
//
//   node scripts/seed-finishedstock-sample.js           # preview
//   node scripts/seed-finishedstock-sample.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const SAMPLE_REMARK = "Sample stock (seed-finishedstock-sample)";
const MAX_SAMPLE_ROLLS = 5;
const SAMPLE_ROLL_MTRS = 500;

// "C001WB-D" -> "C001WB"; "C004WB (DR)-B" -> "C004WB (DR)". Same rule as
// baseProductCode() in routes/stock/finishedStock.js.
const baseCode = (code) => {
  const c = String(code || "").trim();
  return /^(.*[^-])-[A-Z]+$/.exec(c)?.[1] || c;
};

const sizeNum = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

async function run() {
  await connectDB();

  const already = await FinishedStock.countDocuments({ remarks: SAMPLE_REMARK });
  if (already) {
    console.log(`Sample stock is already present (${already} roll(s)). Nothing written.`);
    await mongoose.disconnect();
    return;
  }

  const deckles = await MaterialStock.find({
    quantity: { $gt: 0 },
    reelMtrs: { $gt: 0 },
    producedFor: { $ne: null },
  })
    .populate({ path: "material", select: "productCode skuCode family" })
    .populate({ path: "producedFor", select: "paperSize" })
    .sort({ createdAt: 1 })
    .lean();

  // Client orders that can take a roll: a plain order (not a deckle batch),
  // with a client, a rate and a width. Read once, then matched per Deckle.
  const orders = await PendingProduction.find({
    isDeckleBatch: { $ne: true },
    userId: { $ne: null },
    orderRate: { $gt: 0 },
    paperSize: { $nin: [null, ""] },
    itemId: { $ne: null },
  })
    .populate({ path: "itemId", select: "productCode skuCode family" })
    .populate({ path: "userId", select: "clientName userName" })
    .sort({ createdAt: 1 })
    .lean();

  const usedOrders = new Set();
  const plan = [];
  for (const deckle of deckles) {
    if (plan.length >= MAX_SAMPLE_ROLLS) break;
    const deckleBase = baseCode(deckle.material?.productCode || deckle.material?.skuCode);
    const webWidth = sizeNum(deckle.size) ?? sizeNum(deckle.producedFor?.paperSize);
    if (!deckleBase) continue;

    const order = orders.find((o) => {
      if (usedOrders.has(String(o._id))) return false;
      if (baseCode(o.itemId?.productCode || o.itemId?.skuCode) !== deckleBase) return false;
      const width = sizeNum(o.paperSize);
      return width > 0 && (webWidth == null || width <= webWidth);
    });
    if (!order) continue;

    usedOrders.add(String(order._id));
    plan.push({
      deckle,
      order,
      productCode: order.itemId.productCode || order.itemId.skuCode,
      family: order.itemId.family || deckle.material?.family || "",
      paperSize: String(order.paperSize),
      mtrs: Math.min(Number(deckle.reelMtrs), SAMPLE_ROLL_MTRS),
      rate: Number(order.orderRate),
      clientName: order.userId?.clientName || order.userId?.userName || "",
      lotNo: deckle.lotNo || order.lotNo || "",
    });
  }

  if (!plan.length) {
    console.log("No Deckle in stock matches a client order by Product Code and width. Nothing to add.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Sample Finished Goods rolls (${plan.length}):`);
  for (const p of plan) {
    console.log(
      `  ${p.productCode.padEnd(14)} ${p.paperSize.padStart(4)} mm  ${String(p.mtrs).padStart(4)} m`
      + `  rate ${p.rate}  ${p.clientName || "-"}  from Deckle ${p.deckle.rollId} (${p.deckle.location})`,
    );
  }

  if (!APPLY) {
    console.log("\nDry run -- nothing written. Re-run with --apply to commit.");
    await mongoose.disconnect();
    return;
  }

  const created = [];
  for (const p of plan) {
    const rollId = await generateFinishedRollId(p.productCode);
    const doc = await FinishedStock.create({
      pendingProductionId: p.order._id,
      material: p.order.itemId._id,
      deckleStockId: p.deckle._id,
      deckleRollId: p.deckle.rollId,
      location: p.deckle.location,
      paperSize: p.paperSize,
      lotNo: p.lotNo,
      clientName: p.clientName,
      quantity: 1,
      mtrs: p.mtrs,
      rate: p.rate,
      rollId,
      remarks: SAMPLE_REMARK,
    });
    created.push(doc);
  }

  // One INWARD line per roll, opening/closing counted per Label Stock and
  // location the way the Produce route does it.
  const byKey = new Map();
  for (const doc of created) {
    const key = `${String(doc.material)}|${doc.location}`;
    byKey.set(key, [...(byKey.get(key) || []), doc]);
  }
  for (const rows of byKey.values()) {
    const { material, location } = rows[0];
    const bal = await FinishedStock.aggregate([
      { $match: { material, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    let opening = (bal[0]?.qty || 0) - rows.length;
    for (const doc of rows) {
      await FinishedStockLog.create({
        material,
        location,
        openingStock: opening,
        quantity: 1,
        closingStock: opening + 1,
        rollId: doc.rollId,
        mtrs: doc.mtrs,
        rate: doc.rate,
        type: "INWARD",
        source: "MANUAL",
        remarks: `${SAMPLE_REMARK} -- slit from Deckle ${doc.deckleRollId}`,
        createdBy: "SYSTEM",
      });
      opening += 1;
    }
  }

  console.log(`\nAdded ${created.length} sample roll(s): ${created.map((d) => d.rollId).join(", ")}`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("SEED FINISHED STOCK SAMPLE ERROR:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
