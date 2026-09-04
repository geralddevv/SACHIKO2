import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import MaterialStockLog from "../../models/inventory/materialStockLog.js";
import FinishedStock from "../../models/inventory/finishedStock.js";
import FinishedStockLog from "../../models/inventory/finishedStockLog.js";
import SlittingJobCard from "../../models/inventory/slittingJobCard.js";
import Machine from "../../models/system/machine.js";
import Employee from "../../models/hr/employee_model.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter } from "../../utils/limiters.js";
import { generateFinishedRollId } from "../../utils/finishedRollId.js";
import { normalizeLocationName } from "../../utils/locations.js";

const router = express.Router();

// ----------------------------------Slitting---------------------------------->
//
// The step after lamination. The machine job card (routes/system/machine.js)
// turns raw reels into Deckles -- full-width laminated webs in Semi Finished
// Goods (MaterialStock). Slitting cuts one of those webs into the finished
// roll widths a client order asked for, which land in Finished Goods
// (FinishedStock).
//
// Split in two, the same way Assign Production and the Machine Job Card are:
//
//   PLANNER  /slitting/allocate/:pendingId
//     Picks the machine, operator and helper, the Deckles to cut, and per
//     Deckle its web width, the metres to run off it, the length per finished
//     roll and the A..G knife layout. Writes an "allocated" SlittingJobCard.
//     Nothing moves in stock.
//
//   OPERATOR /slitting/jobcard/:cardId
//     Reached off their machine queue. Per Deckle: scan the reel to confirm
//     it, Start, Stop, confirm the metres that actually ran. Each Stop inwards
//     that row's finished rolls and draws the metres off the Deckle.
//
// This router is mounted on the bare "/sachiko" prefix ahead of the
// role-gated routers (see server.js), so like machine.js every route carries
// its own gate; operators are admitted to the job card because slitting is
// shop-floor work, but never to allocation.
const requireSlittingPlanner = requireRole(["proprietor", "admin", "hod"]);
const requireSlittingFloor = requireRole(["proprietor", "admin", "hod", "operator"]);
const requireSlittingView = requireRole(["proprietor", "admin", "hod", "sales", "operator"]);

// Knife positions across one Deckle web -- exactly the columns on the paper
// card.
export const CUT_SLOTS = ["A", "B", "C", "D", "E", "F", "G"];
const MAX_ROWS_PER_CARD = 40;

// Machine.machineType is free text (see models/system/machine.js), so slitters
// are matched on the stem rather than an exact string -- "SLITTING",
// "SLITTER" and "SLITTING MACHINE" all read as one. Deliberately narrow: the
// other types in use ("COATING", "SHEET CUT") do not contain it.
const SLITTING_MACHINE_RE = /SLIT/i;

const trim = (value) => String(value ?? "").trim();
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const numOrNull = (value) => {
  if (value === undefined || value === null || trim(value) === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Same `SP | <CODE> | 000001` scheme as the machine job card's own ids.
async function generateSlittingId() {
  const counter = await Counter.findOneAndUpdate(
    { key: "slittingJobCardId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | SJC | ${String(counter.seq).padStart(6, "0")}`;
}

async function previewSlittingId() {
  const counter = await Counter.findOne({ key: "slittingJobCardId" }).select("seq").lean();
  return `SP | SJC | ${String(Number(counter?.seq || 0) + 1).padStart(6, "0")}`;
}

// The Label Stock rows carrying EXACTLY this Product Code. A variant code
// ("C011-A") is a different product here -- the suffix only records which
// brand of raw material a Deckle was laminated from, so a client defect can
// be traced back to it. Variants are never interchangeable with the base
// code (or each other) on the floor.
async function labelStockIdsForCode(productCode) {
  const code = trim(productCode);
  if (!code) return [];
  const rows = await SachikoLabelStock.find({ productCode: code }).select("_id").lean();
  return rows.map((r) => r._id);
}

// Deckles this order may be slit from, richest link first:
//   1. produced for it (the job-card path stamps MaterialStock.producedFor),
//   2. ticked onto it on Assign Production (allottedRollIds, older flow),
//   3. any other Deckle of the same Product Code still in stock -- the floor
//      routinely finishes an order off a web laminated on an earlier run.
// Every offered reel must carry the order's EXACT Product Code: the
// producedFor / allotted links are trusted to point at the right stock, but
// a mislink -- or a variant reel -- must never surface here, because the
// finished rolls are named after the Deckle's code. Only reels that still
// carry metres are offered.
async function deckleOptionsFor(pending) {
  const orderCode = trim(pending?.itemId?.productCode || pending?.itemId?.skuCode);
  const materialIds = await labelStockIdsForCode(orderCode);
  const or = [{ producedFor: pending._id }];
  const allotted = Array.isArray(pending.allottedRollIds) ? pending.allottedRollIds : [];
  if (allotted.length) or.push({ _id: { $in: allotted } });
  if (materialIds.length) or.push({ material: { $in: materialIds } });

  const reels = await MaterialStock.find({ $or: or, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
    .populate({ path: "material", select: "productCode skuCode" })
    .sort({ createdAt: 1 })
    .lean();

  const materialSet = new Set(materialIds.map(String));
  const sameCode = (r) => {
    const mid = r.material?._id ? String(r.material._id) : String(r.material || "");
    if (materialSet.has(mid)) return true;
    const code = trim(r.material?.productCode || r.material?.skuCode);
    return orderCode && code ? code === orderCode : false;
  };

  const allottedSet = new Set(allotted.map(String));
  return (orderCode ? reels.filter(sameCode) : reels).map((r) => ({
    _id: String(r._id),
    rollId: r.rollId,
    reelMtrs: round2(Number(r.reelMtrs) || 0),
    // The Deckle web's own width as recorded when it was laminated; falls
    // back to the order's paper size for reels made before it was stored.
    size: r.size || pending.paperSize || "",
    location: r.location || "",
    lotNo: r.lotNo || "",
    productCode: r.material?.productCode || r.material?.skuCode || "",
    // Whether this reel belongs to the order or was pulled off general stock
    // -- the picker groups on it.
    ownOrder: String(r.producedFor || "") === String(pending._id) || allottedSet.has(String(r._id)),
  }));
}

// Every open slitting job on a machine / for an operator, in the shape the
// queue pages render. Exported so routes/system/machine.js can fold slitting
// jobs into the machine and operator queues without re-deriving any of it.
export async function buildSlittingQueueRows(match) {
  const cards = await SlittingJobCard.find({ status: "allocated", ...match })
    .sort({ createdAt: 1 })
    .lean();

  return cards.map((c) => {
    const rows = Array.isArray(c.slittingLog) ? c.slittingLog : [];
    const done = rows.filter((r) => r.status === "done").length;
    return {
      _id: String(c._id),
      slittingJobCardId: c.slittingJobCardId,
      machineId: String(c.machineId || ""),
      machineName: c.machineName || "",
      lotNo: c.lotNo || "—",
      clientOrderNo: c.clientOrderNo || "—",
      productCode: c.productCode || "—",
      clientName: c.clientName || "—",
      operatorName: c.operatorName || "—",
      helperName: c.helperName || "—",
      deckleCount: rows.length,
      deckleDone: done,
      deckleLeft: rows.length - done,
      // Rolls this card will produce once every row is run.
      plannedRolls: rows.reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
      producedRolls: rows
        .filter((r) => r.status === "done")
        .reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
    };
  });
}

// ---- Slitting Queue: orders carrying Deckle stock still to be cut ----------
router.get("/slitting/queue", requireSlittingView, async (req, res) => {
  const orders = await PendingProduction.find({ deckleBatchId: null })
    .populate({ path: "itemId", select: "productCode skuCode" })
    .populate({ path: "userId", select: "clientName userName" })
    .sort({ assignedAt: -1, createdAt: -1 })
    .lean();

  // One pass over every Deckle with metres left, then matched back to the
  // orders above -- an order qualifies through any of the three links
  // deckleOptionsFor uses, so resolving it per order would be N queries.
  const reels = await MaterialStock.find({ reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
    .select("material producedFor reelMtrs rollId")
    .lean();

  const byProducedFor = new Map();
  const byMaterial = new Map();
  for (const r of reels) {
    if (r.producedFor) {
      const k = String(r.producedFor);
      byProducedFor.set(k, (byProducedFor.get(k) || []).concat(r));
    }
    const m = String(r.material);
    byMaterial.set(m, (byMaterial.get(m) || []).concat(r));
  }

  // Product Code -> the Label Stock material ids carrying exactly it, resolved
  // once per distinct code across the whole queue rather than once per order.
  const codes = [...new Set(orders.map((o) => trim(o.itemId?.productCode || o.itemId?.skuCode)).filter(Boolean))];
  const materialIdsByCode = new Map();
  for (const code of codes) materialIdsByCode.set(code, (await labelStockIdsForCode(code)).map(String));

  const [slitCounts, openCards] = await Promise.all([
    FinishedStock.aggregate([{ $group: { _id: "$pendingProductionId", rolls: { $sum: 1 } } }]),
    SlittingJobCard.find({ status: "allocated" })
      .select("pendingProductionId slittingJobCardId machineName operatorName slittingLog")
      .lean(),
  ]);
  const slitByOrder = new Map(slitCounts.map((s) => [String(s._id), s.rolls]));
  const openByOrder = new Map(openCards.map((c) => [String(c.pendingProductionId), c]));

  const rows = [];
  for (const o of orders) {
    const code = trim(o.itemId?.productCode || o.itemId?.skuCode);
    const codeIds = new Set(materialIdsByCode.get(code) || []);
    const allotted = new Set((o.allottedRollIds || []).map(String));
    const seen = new Set();
    const mine = [];
    const add = (r) => {
      const k = String(r._id);
      if (seen.has(k)) return;
      // Only Deckles whose Label Stock carries exactly this order's Product
      // Code -- a variant reel is a different product and cannot be slit here.
      if (codeIds.size && !codeIds.has(String(r.material))) return;
      seen.add(k);
      mine.push(r);
    };
    (byProducedFor.get(String(o._id)) || []).forEach(add);
    reels.filter((r) => allotted.has(String(r._id))).forEach(add);
    (materialIdsByCode.get(code) || []).forEach((mid) => (byMaterial.get(mid) || []).forEach(add));
    if (!mine.length) continue;

    const open = openByOrder.get(String(o._id));
    const openRows = Array.isArray(open?.slittingLog) ? open.slittingLog : [];
    rows.push({
      _id: String(o._id),
      lotNo: o.lotNo || "—",
      clientOrderNo: o.poNumber || "—",
      productCode: code || "—",
      clientName: o.userId?.clientName || o.userId?.userName || "—",
      paperSize: o.paperSize || "—",
      noOfRolls: o.noOfRolls ?? null,
      rollsSlit: slitByOrder.get(String(o._id)) || 0,
      deckleCount: mine.length,
      deckleMtrs: round2(mine.reduce((n, r) => n + (Number(r.reelMtrs) || 0), 0)),
      // An order already carrying an allocated card links straight to it
      // rather than offering to allocate a second one.
      openCard: open
        ? {
            _id: String(open._id),
            slittingJobCardId: open.slittingJobCardId,
            machineName: open.machineName || "—",
            operatorName: open.operatorName || "—",
            deckleLeft: openRows.filter((r) => r.status !== "done").length,
            deckleCount: openRows.length,
          }
        : null,
    });
  }

  res.render("inventory/masters/slittingQueue.ejs", {
    title: "Slitting Queue",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    notification: req.flash("notification"),
  });
});

// ---- Allocation: the planner fixes the whole job up front ------------------
router.get("/slitting/allocate/:pendingId", requireSlittingPlanner, async (req, res) => {
  const { pendingId } = req.params;
  if (!mongoose.isValidObjectId(pendingId)) {
    req.flash("notification", "Invalid order id.");
    return res.redirect("/sachiko/slitting/queue");
  }

  const pending = await PendingProduction.findById(pendingId)
    .populate({ path: "itemId", select: "productCode skuCode" })
    .populate({ path: "userId", select: "clientName userName" })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .lean();
  if (!pending) {
    req.flash("notification", "That production order no longer exists.");
    return res.redirect("/sachiko/slitting/queue");
  }

  const deckles = await deckleOptionsFor(pending);
  if (!deckles.length) {
    req.flash("notification", "No Deckle stock left to slit for this order.");
    return res.redirect("/sachiko/slitting/queue");
  }

  // One allocation emits one card PER DECKLE, so re-opening this page loads
  // every card still open against the order and shows them as its rows. The
  // planner edits the set; cards whose Deckle has already been run are
  // finished work and are listed separately, not edited.
  const openCards = await SlittingJobCard.find({
    pendingProductionId: pending._id,
    status: "allocated",
  })
    .sort({ createdAt: 1 })
    .lean();
  const ranCards = await SlittingJobCard.find({
    pendingProductionId: pending._id,
    status: "completed",
  })
    .select("slittingJobCardId slittingLog")
    .sort({ createdAt: 1 })
    .lean();

  const [machines, operators, helpers] = await Promise.all([
    Machine.find({ machineType: SLITTING_MACHINE_RE }).populate("location").sort({ machineName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empProfileCode empLoc").sort({ empName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "HELPER" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
  ]);

  const order = {
    _id: String(pending._id),
    lotNo: pending.lotNo || "",
    clientOrderNo: pending.poNumber || "",
    clientName: pending.userId?.clientName || pending.userId?.userName || "",
    productCode: pending.itemId?.productCode || pending.itemId?.skuCode || "",
    // The ordered finished-roll width, and the length/count asked for --
    // these seed the card's first requirement line.
    paperSize: pending.paperSize || "",
    runningMeters: pending.deckleRunningMeters ?? pending.runningMeters ?? null,
    noOfRolls: pending.noOfRolls ?? null,
    operatorName: pending.operatorId?.empName || "",
    helperName: pending.helperId?.empName || "",
  };

  const previewCardId = openCards.length
    ? (openCards.length === 1 ? openCards[0].slittingJobCardId : `${openCards.length} Cards Allocated`)
    : await previewSlittingId();

  res.render("inventory/masters/slittingAllocation.ejs", {
    title: "Slitting Allocation",
    CSS: false,
    JS: false,
    order,
    deckles,
    cutSlots: CUT_SLOTS,
    previewCardId,
    machines: machines.map((m) => ({
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "",
      locationName: m.location?.locationName || "",
      // Key an operator is matched on: their profile code is set to the
      // machine name they run, and they only run it at their own location.
      operatorKey: `${String(m.machineName).trim().toUpperCase()}||${normalizeLocationName(m.location?.locationName)}`,
    })),
    operators: operators.map((e) => ({
      _id: String(e._id),
      empName: e.empName,
      operatorKey: `${String(e.empProfileCode || "").trim().toUpperCase()}||${normalizeLocationName(e.empLoc)}`,
    })),
    helpers: helpers.map((e) => ({ _id: String(e._id), empName: e.empName })),
    // The machine/operator/helper of the open cards -- they were allocated
    // together, so the first one speaks for all of them.
    existing: openCards.length
      ? {
          machineId: String(openCards[0].machineId || ""),
          operatorId: String(openCards[0].operatorId || ""),
          helperId: String(openCards[0].helperId || ""),
          slittingJobCardId: openCards[0].slittingJobCardId || "",
          rows: openCards.map((c) => {
            const r = (c.slittingLog || [])[0] || {};
            return {
              cardId: String(c._id),
              slittingJobCardId: c.slittingJobCardId,
              deckleStockId: String(r.deckleStockId || ""),
              deckleId: r.deckleId || "",
              width: r.width ?? null,
              plannedMeter: r.plannedMeter ?? null,
              plannedRunningMeter: r.plannedRunningMeter ?? null,
              cuts: Object.fromEntries((r.cuts || []).map((c2) => [c2.slot, c2.width])),
            };
          }),
        }
      : null,
    // Cards already run against this order. Their stock has moved, so they
    // are reported, never edited.
    ranCards: ranCards.map((c) => ({
      slittingJobCardId: c.slittingJobCardId,
      deckleId: ((c.slittingLog || [])[0] || {}).deckleId || "",
    })),
    submissionToken: randomUUID(),
    notification: req.flash("notification"),
  });
});

router.post("/slitting/allocate/:pendingId", requireAuth, requireSlittingPlanner, createLimiter, async (req, res) => {
  const fail = (message) => res.status(400).json({ success: false, message });
  try {
    const { pendingId } = req.params;
    if (!mongoose.isValidObjectId(pendingId)) return fail("Invalid order.");

    const pending = await PendingProduction.findById(pendingId)
      .populate({ path: "itemId", select: "productCode skuCode" })
      .populate({ path: "userId", select: "clientName userName" })
      .lean();
    if (!pending) return fail("Order not found.");

    const b = req.body || {};

    if (!mongoose.isValidObjectId(b.machineId)) return fail("Select a slitting machine.");
    const machine = await Machine.findById(b.machineId).select("machineName machineType").lean();
    if (!machine) return fail("Select a valid slitting machine.");
    if (!SLITTING_MACHINE_RE.test(machine.machineType || "")) {
      return fail(`"${machine.machineName}" is not a slitting machine.`);
    }

    if (!mongoose.isValidObjectId(b.operatorId)) return fail("Select an operator.");
    const operator = await Employee.findById(b.operatorId).select("empName").lean();
    if (!operator) return fail("Select a valid operator.");

    let helper = null;
    if (trim(b.helperId)) {
      if (!mongoose.isValidObjectId(b.helperId)) return fail("Select a valid helper.");
      helper = await Employee.findById(b.helperId).select("empName").lean();
      if (!helper) return fail("Select a valid helper.");
    }

    const rawRows = Array.isArray(b.rows) ? b.rows : [];
    if (!rawRows.length) return fail("Allocate at least one Deckle.");
    if (rawRows.length > MAX_ROWS_PER_CARD) {
      return fail(`A slitting card can hold at most ${MAX_ROWS_PER_CARD} Deckles.`);
    }

    // Normalize + validate the whole plan before writing any of it.
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i] || {};
      const label = `Row ${i + 1}`;
      if (!mongoose.isValidObjectId(r.deckleStockId)) return fail(`${label}: select a Deckle.`);

      const plannedMeter = numOrNull(r.plannedMeter);
      if (!(plannedMeter > 0)) return fail(`${label}: enter the metres to run off the Deckle.`);

      const plannedRunningMeter = numOrNull(r.plannedRunningMeter);
      if (!(plannedRunningMeter > 0)) return fail(`${label}: enter the R. Meter for each roll.`);

      const cuts = CUT_SLOTS.map((slot) => ({ slot, width: numOrNull(r.cuts?.[slot]) }))
        .filter((c) => c.width !== null);
      if (!cuts.length) return fail(`${label}: enter at least one roll width (A–G).`);
      if (cuts.some((c) => !(c.width > 0))) return fail(`${label}: roll widths must be greater than zero.`);

      const width = numOrNull(r.width);
      const cutTotal = round2(cuts.reduce((n, c) => n + c.width, 0));
      // The knives cannot cut more web than the Deckle has. Equal is fine --
      // a layout with no edge trim at all.
      if (width !== null && cutTotal > width) {
        return fail(`${label}: roll widths total ${cutTotal} mm but the Deckle web is only ${width} mm.`);
      }

      rows.push({
        deckleStockId: r.deckleStockId,
        width,
        cuts,
        plannedMeter: round2(plannedMeter),
        plannedRunningMeter: round2(plannedRunningMeter),
        status: "pending",
      });
    }

    // One Deckle may be planned across more than one row; check its whole
    // demand at once so two rows can't each pass on the same metres.
    const demandByDeckle = new Map();
    for (const r of rows) {
      const k = String(r.deckleStockId);
      demandByDeckle.set(k, round2((demandByDeckle.get(k) || 0) + r.plannedMeter));
    }

    const reels = await MaterialStock.find({ _id: { $in: [...demandByDeckle.keys()] } })
      .populate({ path: "material", select: "productCode skuCode" })
      .lean();
    const reelById = new Map(reels.map((r) => [String(r._id), r]));

    for (const [id, wanted] of demandByDeckle) {
      const reel = reelById.get(id);
      if (!reel) return fail("A selected Deckle no longer exists — reload the page.");
      const available = round2(Number(reel.reelMtrs) || 0);
      if (wanted > available) {
        return fail(`Deckle "${reel.rollId}" only has ${available} mtrs left — this plan asks for ${wanted}.`);
      }
    }

    // Finished rolls are inwarded where their Deckle already sits; a card
    // mixing locations would need two inward ledgers, so it is refused.
    const locations = [...new Set(reels.map((r) => trim(r.location)).filter(Boolean))];
    if (locations.length !== 1) {
      return fail(
        locations.length === 0
          ? "The selected Deckle has no location on it."
          : `The selected Deckles sit at different locations (${locations.join(", ")}) — allocate them on separate cards.`,
      );
    }

    // Every finished roll is named after the Product Code of the Deckle it
    // came off. Check that up front rather than failing mid-run.
    const codeless = reels.find(
      (r) => !trim(r.material?.productCode || r.material?.skuCode || pending.itemId?.productCode),
    );
    if (codeless) {
      return fail(`Deckle "${codeless.rollId}" has no Product Code on its Label Stock — it cannot be slit.`);
    }

    // A Deckle can only be slit against an order carrying its EXACT Product
    // Code -- the finished rolls take the Deckle's code, and a variant reel
    // ("C011-A") is a different product, not a substitute for "C011".
    const orderCode = trim(pending.itemId?.productCode || pending.itemId?.skuCode);
    if (orderCode) {
      const foreign = reels.find((r) => {
        const code = trim(r.material?.productCode || r.material?.skuCode);
        return code && code !== orderCode;
      });
      if (foreign) {
        const code = trim(foreign.material?.productCode || foreign.material?.skuCode);
        return fail(
          `Deckle "${foreign.rollId}" is Product Code ${code} — this order is ${orderCode}. Only ${orderCode} Deckles can be slit here.`,
        );
      }
    }

    // The order's own requirement -- the finished width it asked for, the
    // length per roll and the count. Read off the order, never from the form:
    // the allocation page shows it read-only because it is the sales order's,
    // not the planner's, to change. paperSize is free text ("660", '26"'), so
    // the leading number is what goes into the numeric field.
    const requirements = [
      {
        width: numOrNull(/-?\d+(\.\d+)?/.exec(String(pending.paperSize ?? ""))?.[0]),
        runningMeter: pending.deckleRunningMeters ?? pending.runningMeters ?? null,
        qty: pending.noOfRolls ?? null,
      },
    ].filter((q) => q.width !== null || q.runningMeter !== null || q.qty !== null);

    // Every Deckle is its own job: this allocation emits ONE card per row.
    // Re-allocating an order therefore reconciles a SET of cards -- an open
    // card whose Deckle is still listed is updated in place (so it keeps its
    // id, and the operator's queue entry doesn't churn), one whose Deckle was
    // dropped is deleted, and a newly listed Deckle gets a fresh card.
    const openCards = await SlittingJobCard.find({
      pendingProductionId: pending._id,
      status: "allocated",
    });
    const openByDeckle = new Map(
      openCards.map((c) => [String((c.slittingLog || [])[0]?.deckleStockId || ""), c]),
    );

    // A card already run is finished work -- its stock has moved and it is
    // never touched here. Its Deckle may legitimately be allocated again
    // (a part-drawn reel still carrying metres), which is why this only
    // guards the open set above, not the completed one.
    const shared = {
      status: "allocated",
      pendingProductionId: pending._id,
      machineId: machine._id,
      machineName: machine.machineName || "",
      operatorId: operator._id,
      operatorName: operator.empName || "",
      helperId: helper?._id,
      helperName: helper?.empName || "",
      clientOrderNo: trim(b.clientOrderNo) || pending.poNumber || "",
      clientName: pending.userId?.clientName || pending.userId?.userName || "",
      productCode: pending.itemId?.productCode || pending.itemId?.skuCode || "",
      lotNo: pending.lotNo || "",
      location: locations[0],
      requirements,
      allocatedBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
    };

    const submissionToken = trim(b.submissionToken) || undefined;
    if (submissionToken && (await SlittingJobCard.exists({ submissionToken }))) {
      // A resubmit of the same loaded page. The first one landed; don't
      // duplicate the whole set.
      return res.json({ success: true, redirect: "/sachiko/slitting/queue" });
    }

    const created = [];
    const updated = [];
    const keptDeckles = new Set();

    for (const r of rows) {
      const key = String(r.deckleStockId);
      keptDeckles.add(key);
      const deckleId = reelById.get(key)?.rollId || "";
      const existing = openByDeckle.get(key);

      if (existing) {
        Object.assign(existing, shared);
        const prior = (existing.slittingLog || [])[0];
        existing.slittingLog = [{
          ...r,
          deckleId,
          // The token is what makes this card's Stop idempotent, so it is
          // kept across a re-allocation rather than re-minted -- a Stop
          // already in flight must still match.
          rowToken: prior?.rowToken || randomUUID(),
          status: "pending",
        }];
        await existing.save();
        updated.push(existing);
        continue;
      }

      created.push(await SlittingJobCard.create({
        ...shared,
        slittingJobCardId: await generateSlittingId(),
        // The idempotency token belongs to the submission, so only the first
        // card of a batch carries it -- it is uniquely indexed.
        submissionToken: created.length === 0 && !updated.length ? submissionToken : undefined,
        date: b.date ? new Date(b.date) : new Date(),
        slittingLog: [{ ...r, deckleId, rowToken: randomUUID(), status: "pending" }],
      }));
    }

    // Deckles the planner removed from the allocation: their cards were never
    // run, so they are withdrawn entirely rather than left on the queue.
    const dropped = openCards.filter((c) => !keptDeckles.has(String((c.slittingLog || [])[0]?.deckleStockId || "")));
    if (dropped.length) {
      await SlittingJobCard.deleteMany({ _id: { $in: dropped.map((c) => c._id) } });
    }

    const total = created.length + updated.length;
    const summary =
      `${total} slitting job${total === 1 ? "" : "s"} (one per Deckle) on ${machine.machineName} for ${operator.empName}`
      + (dropped.length ? `; ${dropped.length} withdrawn` : "");

    res.locals.auditDescription =
      `Allocated slitting for order ${pending.lotNo || pending._id}: ${summary}`
      + (created.length ? ` — new: ${created.map((c) => c.slittingJobCardId).join(", ")}` : "");
    req.flash("notification", `Allocated ${summary}.`);
    res.json({ success: true, redirect: "/sachiko/slitting/queue" });
  } catch (err) {
    console.error("SLITTING ALLOCATION ERROR:", err);
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      return res.json({ success: true, redirect: "/sachiko/slitting/queue" });
    }
    res.status(500).json({ success: false, message: "Failed to save the slitting allocation." });
  }
});

// ---- The operator's card ---------------------------------------------------
// Declared ahead of the "/:cardId" route below -- Express matches in
// declaration order, and "view" would otherwise be read as a card id.
router.get("/slitting/jobcard/view", requireSlittingView, async (req, res) => {
  const cards = await SlittingJobCard.find().sort({ createdAt: -1 }).lean();

  res.render("inventory/masters/slittingJobCardView.ejs", {
    title: "Slitting Records",
    CSS: "tableDisp.css",
    JS: false,
    cutSlots: CUT_SLOTS,
    jsonData: cards,
    notification: req.flash("notification"),
  });
});

// ---- The operator's card ---------------------------------------------------
router.get("/slitting/jobcard/:cardId", requireSlittingFloor, async (req, res) => {
  const { cardId } = req.params;
  if (!mongoose.isValidObjectId(cardId)) {
    req.flash("notification", "Invalid slitting card.");
    return res.redirect("/sachiko/slitting/queue");
  }

  const card = await SlittingJobCard.findById(cardId).lean();
  if (!card) {
    req.flash("notification", "That slitting card no longer exists.");
    return res.redirect("/sachiko/slitting/queue");
  }
  if (card.status === "completed") {
    req.flash("notification", `${card.slittingJobCardId} is already finished.`);
    return res.redirect("/sachiko/slitting/jobcard/view");
  }

  // Live remaining metres per allocated reel, so a row whose Deckle has been
  // drawn down elsewhere since allocation shows the truth rather than the
  // plan.
  const stockIds = (card.slittingLog || []).map((r) => r.deckleStockId).filter(Boolean);
  const reels = stockIds.length
    ? await MaterialStock.find({ _id: { $in: stockIds } }).select("rollId reelMtrs location").lean()
    : [];
  const reelById = new Map(reels.map((r) => [String(r._id), r]));

  res.render("inventory/masters/slittingJobCardForm.ejs", {
    title: "Slitting Job Card",
    CSS: false,
    JS: false,
    card: {
      _id: String(card._id),
      slittingJobCardId: card.slittingJobCardId,
      date: card.date,
      machineName: card.machineName || "",
      operatorName: card.operatorName || "",
      helperName: card.helperName || "",
      clientOrderNo: card.clientOrderNo || "",
      clientName: card.clientName || "",
      productCode: card.productCode || "",
      lotNo: card.lotNo || "",
      location: card.location || "",
      requirements: card.requirements || [],
      rows: (card.slittingLog || []).map((r, i) => {
        const reel = reelById.get(String(r.deckleStockId));
        return {
          index: i,
          deckleId: r.deckleId || reel?.rollId || "",
          width: r.width ?? null,
          cuts: (r.cuts || []).map((c) => ({ slot: c.slot, width: c.width, rollId: c.rollId || "" })),
          plannedMeter: r.plannedMeter ?? null,
          plannedRunningMeter: r.plannedRunningMeter ?? null,
          status: r.status || "pending",
          meter: r.meter ?? null,
          runningMeter: r.runningMeter ?? null,
          startTime: r.startTime || "",
          endTime: r.endTime || "",
          joint: r.joint || "",
          jointMtr: r.jointMtr ?? null,
          // What is actually left on the reel right now.
          reelMtrs: reel ? round2(Number(reel.reelMtrs) || 0) : null,
        };
      }),
    },
    notification: req.flash("notification"),
  });
});

// Stamps the clock on one row when the operator punches Start. Deliberately
// separate from produce: a run that is started and then abandoned leaves a
// start time and no stock movement, which is exactly what happened.
router.post("/slitting/jobcard/row/start", requireAuth, requireSlittingFloor, updateLimiter, async (req, res) => {
  try {
    const { cardId, index, startTime } = req.body || {};
    if (!mongoose.isValidObjectId(cardId)) return res.status(400).json({ success: false, message: "Invalid card." });

    const card = await SlittingJobCard.findById(cardId);
    if (!card) return res.status(404).json({ success: false, message: "Card not found." });

    const i = Number(index);
    const row = card.slittingLog?.[i];
    if (!row) return res.status(400).json({ success: false, message: "That Deckle is not on this card." });
    if (row.status === "done") return res.status(400).json({ success: false, message: "That Deckle has already been run." });

    row.startTime = trim(startTime) || row.startTime;
    await card.save();
    res.json({ success: true, startTime: row.startTime });
  } catch (err) {
    console.error("SLITTING ROW START ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to record the start time." });
  }
});

// Stop. Inwards this row's finished rolls -- one per allocated roll width --
// and draws the metres that actually ran off the Deckle. This is the only
// place slitting moves stock.
router.post("/slitting/jobcard/row/produce", requireAuth, requireSlittingFloor, createLimiter, async (req, res) => {
  const fail = (message) => res.status(400).json({ success: false, message });
  try {
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.cardId)) return fail("Invalid card.");

    const card = await SlittingJobCard.findById(b.cardId);
    if (!card) return res.status(404).json({ success: false, message: "Card not found." });

    const i = Number(b.index);
    const row = card.slittingLog?.[i];
    if (!row) return fail("That Deckle is not on this card.");

    // Idempotent replay: this row's rolls already exist, so the first attempt
    // committed and only its response was lost. Hand back the same rolls
    // rather than inwarding a second set.
    if (row.status === "done") {
      return res.json({
        success: true,
        replayed: true,
        rollIds: (row.cuts || []).map((c) => c.rollId).filter(Boolean),
        meter: row.meter,
        runningMeter: row.runningMeter,
        endTime: row.endTime,
        cardCompleted: card.status === "completed",
      });
    }

    // The operator confirms what actually ran; the plan is only the default.
    const meter = numOrNull(b.meter);
    if (!(meter > 0)) return fail("Enter the metres that actually ran.");
    const runningMeter = numOrNull(b.runningMeter);
    if (!(runningMeter > 0)) return fail("Enter the R. Meter wound on each roll.");

    const cuts = Array.isArray(row.cuts) ? row.cuts.filter((c) => Number(c.width) > 0) : [];
    if (!cuts.length) return fail("This Deckle has no roll widths allocated.");

    const reel = await MaterialStock.findById(row.deckleStockId)
      .populate({ path: "material", select: "productCode skuCode" })
      .lean();
    if (!reel) return fail("That Deckle no longer exists.");

    const available = round2(Number(reel.reelMtrs) || 0);
    if (meter > available) {
      return fail(`Deckle "${reel.rollId}" only has ${available} mtrs left — you entered ${meter}.`);
    }

    const location = trim(reel.location) || card.location;
    if (!location) return fail("The Deckle has no stock location on it.");

    const material = reel.material?._id || reel.material;
    const code = reel.material?.productCode || reel.material?.skuCode || card.productCode;
    if (!trim(code)) return fail("The Deckle's Label Stock has no Product Code.");

    const createdBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";

    // ---- Finished Goods in ------------------------------------------------
    // One roll per allocated width. The roll is booked against the Deckle's
    // OWN Label Stock (a variant "-A" web stays an "-A" roll), not the
    // order's SKU, so finished stock keeps naming what was physically made.
    const bal = await FinishedStock.aggregate([
      { $match: { material: new mongoose.Types.ObjectId(String(material)), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    let opening = bal[0]?.qty || 0;

    const createdRolls = [];
    for (const cut of cuts) {
      const rollId = await generateFinishedRollId(code);
      const doc = await FinishedStock.create({
        pendingProductionId: card.pendingProductionId,
        material,
        deckleStockId: reel._id,
        deckleRollId: reel.rollId,
        location,
        // The finished roll's own width -- the knife position it came off,
        // not the order's nominal size (they differ on a mixed layout).
        paperSize: String(cut.width),
        lotNo: reel.lotNo || card.lotNo || "",
        clientName: card.clientName || "",
        quantity: 1,
        mtrs: round2(runningMeter),
        rate: reel.rate,
        rollId,
      });
      cut.rollId = rollId;
      cut.stockId = doc._id;
      createdRolls.push(rollId);

      await FinishedStockLog.create({
        material,
        location,
        openingStock: opening,
        quantity: 1,
        closingStock: opening + 1,
        mtrs: round2(runningMeter),
        rate: reel.rate,
        rollId,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `${card.slittingJobCardId}: slit from Deckle ${reel.rollId} at ${cut.slot} — ${cut.width} mm × ${round2(runningMeter)} mtrs`,
        createdBy,
      });
      opening += 1;
    }

    // ---- Semi Finished Goods out ------------------------------------------
    // Same emptying rule as every other consumer of a Deckle: a reel taken to
    // 0 mtrs is emptied, quantity and all.
    const remaining = round2(available - meter);
    const emptied = remaining <= 0;
    await MaterialStock.updateOne(
      { _id: reel._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

    const matBal = await MaterialStock.aggregate([
      { $match: { material: new mongoose.Types.ObjectId(String(material)), location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    // The update above already landed, so add the emptied roll back to
    // recover the balance as it stood before this line.
    const matOpening = (matBal[0]?.qty || 0) + (emptied ? 1 : 0);
    await MaterialStockLog.create({
      material,
      location: reel.location,
      openingStock: matOpening,
      quantity: emptied ? 1 : 0,
      closingStock: matOpening - (emptied ? 1 : 0),
      reelMtrs: round2(meter),
      rate: reel.rate,
      rollId: reel.rollId,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `${card.slittingJobCardId}: ${round2(meter)} mtrs slit into ${createdRolls.length} finished roll(s)${emptied ? " — reel emptied" : ""}`,
      createdBy,
    });

    // ---- Close the row, and the card once its last row is done ------------
    const cutTotal = round2(cuts.reduce((n, c) => n + Number(c.width), 0));
    row.status = "done";
    row.meter = round2(meter);
    row.runningMeter = round2(runningMeter);
    row.trim = row.width != null ? round2(row.width - cutTotal) : undefined;
    row.joint = trim(b.joint) || undefined;
    row.jointMtr = numOrNull(b.jointMtr) ?? undefined;
    row.endTime = trim(b.endTime) || row.endTime;
    row.producedAt = new Date();

    const done = card.slittingLog.filter((r) => r.status === "done");
    card.totalDeckleMeter = round2(done.reduce((n, r) => n + (Number(r.meter) || 0), 0));
    card.totalRolls = done.reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0);
    card.totalFinishedMeter = round2(
      done.reduce((n, r) => n + (Number(r.runningMeter) || 0) * (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
    );
    const allDone = card.slittingLog.every((r) => r.status === "done");
    if (allDone) {
      card.status = "completed";
      card.completedAt = new Date();
    }
    await card.save();

    res.locals.auditDescription =
      `${card.slittingJobCardId}: slit Deckle "${reel.rollId}" into ${createdRolls.length} finished roll(s) — ${createdRolls.join(", ")}`;
    res.json({
      success: true,
      rollIds: createdRolls,
      meter: row.meter,
      runningMeter: row.runningMeter,
      endTime: row.endTime,
      emptied,
      cardCompleted: allDone,
    });
  } catch (err) {
    console.error("SLITTING ROW PRODUCE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to move these rolls to Finished Stock." });
  }
});

export default router;
