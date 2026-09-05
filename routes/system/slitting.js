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
//   PLANNER  /slitting/allocate/:pendingId?deckle=<stockId>
//     Deckle-scoped -- opened from the Slitting Queue for ONE Deckle. Picks
//     the machine, operator and helper, and that Deckle's web width, the
//     metres to run off it, the length per finished roll and the A..G knife
//     layout. Writes one "allocated" SlittingJobCard bound to that Deckle,
//     which puts it on the chosen machine's queue. Nothing moves in stock.
//     Each of the order's Deckles is allocated on its own visit here.
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

// ---- Deckle curing -------------------------------------------------------->
// After lamination the adhesive has to cure before the web can be slit --
// CURING_HOURS from the moment the Deckle (MaterialStock reel) was created.
// A build whose every adhesive layer is hot melt sets on contact and is
// exempt. The PLANNER's allocation is deliberately NOT gated on this (a job
// can be planned while the reel cures); the OPERATOR's run IS -- Start and
// Stop on the slitting job card refuse an un-cured Deckle, and the machine /
// operator queues flag it.
const CURING_HOURS = 6;
const HOT_MELT_RE = /HOT\s*-?\s*MELT/i;

// Exempt only when there is at least one adhesive layer and EVERY layer
// present is hot melt -- a waterbase + hotmelt double build still cures.
function adhesiveExemptFromCuring(material) {
  const types = [material?.adhesive?.adhesiveType, material?.adhesive2?.adhesiveType]
    .map((t) => trim(t))
    .filter(Boolean);
  return types.length > 0 && types.every((t) => HOT_MELT_RE.test(t));
}

// { hotMelt, curedAt: Date|null, cured: bool } for one Deckle reel. A reel
// with no createdAt (pre-timestamps legacy stock) is treated as cured.
function deckleCuring(reel, at = Date.now()) {
  const hotMelt = adhesiveExemptFromCuring(reel?.material);
  const createdAt = reel?.createdAt ? new Date(reel.createdAt) : null;
  const curedAt = hotMelt || !createdAt
    ? null
    : new Date(createdAt.getTime() + CURING_HOURS * 3600 * 1000);
  const cured = !curedAt || at >= curedAt.getTime();
  return { hotMelt, curedAt, cured };
}

// Short "ready at 14:30 (about 2 h 10 min from now)" tail for messages/labels.
function curingWhenLabel(curedAt, at = Date.now()) {
  if (!curedAt) return "";
  const d = new Date(curedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = d.toDateString() === new Date(at).toDateString();
  return sameDay ? `${hh}:${mm}` : `${hh}:${mm}, ${d.toLocaleDateString("en-IN")}`;
}

function curingBlockedMessage(rollId, curedAt) {
  const mins = Math.max(0, Math.round((new Date(curedAt).getTime() - Date.now()) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `Deckle ${rollId} is still curing (${CURING_HOURS} h after lamination) — ready at `
    + `${curingWhenLabel(curedAt)}, about ${left} from now. Only fully hot-melt Deckles skip curing.`;
}
// <----------------------------------Deckle curing --------------------------

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

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches a Product Code and its raw-material-brand variants ("C003WB",
// "C003WB-A", "C003WB-E", ...). The suffix only records which brand of raw
// material a Deckle was laminated from -- for tracing a client defect back --
// so for slitting a "C003WB" order every "C003WB-*" Deckle is the same
// product. A genuinely different code ("C014AC") is not.
function productCodeFamilyRe(productCode) {
  const code = trim(productCode);
  if (!code) return null;
  const base = /^(.*[^-])-[A-Z]+$/.exec(code)?.[1] || code;
  return new RegExp(`^${escapeRegExp(base)}(-[A-Z]+)?$`);
}

// Every Label Stock row in one Product Code's variant family.
async function labelStockFamilyIds(productCode) {
  const re = productCodeFamilyRe(productCode);
  if (!re) return [];
  const rows = await SachikoLabelStock.find({ productCode: re }).select("_id").lean();
  return rows.map((r) => r._id);
}

// Deckles this order may be slit from, richest link first:
//   1. produced for it (the job-card path stamps MaterialStock.producedFor),
//   2. ticked onto it on Assign Production (allottedRollIds, older flow),
//   3. any other Deckle of the same Product Code still in stock -- the floor
//      routinely finishes an order off a web laminated on an earlier run.
// Every offered reel must carry the order's Product Code (its brand variants
// included): the producedFor / allotted links are NOT trusted blindly -- a
// mislinked reel of a different code must never surface here, because the
// finished rolls are named after the Deckle. Only reels that still carry
// metres are offered.
async function deckleOptionsFor(pending) {
  const orderCode = trim(pending?.itemId?.productCode || pending?.itemId?.skuCode);
  const familyIds = await labelStockFamilyIds(orderCode);
  const or = [{ producedFor: pending._id }];
  const allotted = Array.isArray(pending.allottedRollIds) ? pending.allottedRollIds : [];
  if (allotted.length) or.push({ _id: { $in: allotted } });
  if (familyIds.length) or.push({ material: { $in: familyIds } });

  const reels = await MaterialStock.find({ $or: or, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
    .populate({ path: "material", select: "productCode skuCode adhesive adhesive2" })
    .sort({ createdAt: 1 })
    .lean();

  const familySet = new Set(familyIds.map(String));
  const codeRe = productCodeFamilyRe(orderCode);
  const inFamily = (r) => {
    const mid = r.material?._id ? String(r.material._id) : String(r.material || "");
    if (familySet.has(mid)) return true;
    const code = trim(r.material?.productCode || r.material?.skuCode);
    return codeRe && code ? codeRe.test(code) : false;
  };

  const allottedSet = new Set(allotted.map(String));
  return (codeRe ? reels.filter(inFamily) : reels).map((r) => {
    const cure = deckleCuring(r);
    return {
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
      // Advisory only on allocation -- the plan can be made now, but the
      // operator can't run it until this clears.
      curing: {
        hotMelt: cure.hotMelt,
        cured: cure.cured,
        curedAt: cure.curedAt ? cure.curedAt.toISOString() : null,
        curedAtLabel: cure.curedAt ? curingWhenLabel(cure.curedAt) : "",
      },
    };
  });
}

// Every open slitting job on a machine / for an operator, in the shape the
// queue pages render. Exported so routes/system/machine.js can fold slitting
// jobs into the machine and operator queues without re-deriving any of it.
export async function buildSlittingQueueRows(match) {
  const cards = await SlittingJobCard.find({ status: "allocated", ...match })
    .sort({ createdAt: 1 })
    .lean();

  // Curing state of every Deckle still to run on these cards -- the operator
  // can't work a card until its pending Deckles have cured.
  const pendingDeckleIds = [
    ...new Set(
      cards.flatMap((c) =>
        (c.slittingLog || [])
          .filter((r) => r.status !== "done")
          .map((r) => String(r.deckleStockId || ""))
          .filter(Boolean),
      ),
    ),
  ];
  const cureReels = pendingDeckleIds.length
    ? await MaterialStock.find({ _id: { $in: pendingDeckleIds } })
        .select("createdAt rollId")
        .populate({ path: "material", select: "adhesive adhesive2" })
        .lean()
    : [];
  const cureByReel = new Map(cureReels.map((r) => [String(r._id), deckleCuring(r)]));

  return cards.map((c) => {
    const rows = Array.isArray(c.slittingLog) ? c.slittingLog : [];
    const done = rows.filter((r) => r.status === "done").length;

    const uncured = rows
      .filter((r) => r.status !== "done")
      .map((r) => cureByReel.get(String(r.deckleStockId)))
      .filter((info) => info && !info.cured && info.curedAt);
    const curingUntil = uncured.reduce(
      (max, info) => Math.max(max, new Date(info.curedAt).getTime()),
      0,
    );

    return {
      _id: String(c._id),
      slittingJobCardId: c.slittingJobCardId,
      // For the queue's Edit button -- reopens exactly the Allocate page this
      // card was created from (routes/system/slitting.js "/slitting/allocate").
      pendingProductionId: c.pendingProductionId ? String(c.pendingProductionId) : "",
      deckleStockId: rows[0]?.deckleStockId ? String(rows[0].deckleStockId) : "",
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
      // A Deckle still to run has not finished curing -- the card can be
      // opened but not run yet.
      curing: uncured.length > 0,
      curingUntilLabel: curingUntil ? curingWhenLabel(curingUntil) : "",
      // True once the operator has actually punched Start on a row that
      // hasn't been Stopped yet -- as opposed to a card that is merely
      // allocated and still sitting untouched on the machine's queue. Used
      // to separate "/slitting/wip" (running right now) from the machine
      // queue (every allocated card, run or not).
      running: rows.some((r) => r.status !== "done" && !!r.startTime),
    };
  });
}

// ---- Slitting Queue: every Deckle web still carrying metres ----------------
// One row per Deckle (the laminated web made upstream), not per order. The
// planner picks a Deckle here and "Allocate" opens the Slitting Job Card for
// that Deckle's order with the Deckle pre-filled as the first row.
router.get("/slitting/queue", requireSlittingView, async (req, res) => {
  const [orders, reels] = await Promise.all([
    PendingProduction.find({ deckleBatchId: null })
      .populate({ path: "itemId", select: "productCode skuCode" })
      .populate({ path: "userId", select: "clientName userName" })
      .sort({ assignedAt: -1, createdAt: -1 })
      .lean(),
    MaterialStock.find({ reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
      .populate({ path: "material", select: "productCode skuCode adhesive adhesive2" })
      .select("material producedFor reelMtrs rollId size location lotNo createdAt")
      .sort({ location: 1, rollId: 1 })
      .lean(),
  ]);

  const pendingById = new Map(orders.map((o) => [String(o._id), o]));

  // Product Code -> the Label Stock material ids in its variant family.
  const codes = [...new Set(orders.map((o) => trim(o.itemId?.productCode || o.itemId?.skuCode)).filter(Boolean))];
  const familyByCode = new Map();
  for (const code of codes) familyByCode.set(code, new Set((await labelStockFamilyIds(code)).map(String)));

  // Which order a loose Deckle (no producedFor) belongs to, matched on its
  // Label Stock being ticked onto the order or sharing its Product Code family.
  const orderForReel = (reel) => {
    const direct = reel.producedFor && pendingById.get(String(reel.producedFor));
    if (direct) return { order: direct, by: "producedFor" };
    const rid = String(reel._id);
    const allottedTo = orders.find((o) => (o.allottedRollIds || []).some((x) => String(x) === rid));
    if (allottedTo) return { order: allottedTo, by: "allotted" };
    const mid = reel.material?._id ? String(reel.material._id) : String(reel.material || "");
    const byCode = orders.find((o) => {
      const code = trim(o.itemId?.productCode || o.itemId?.skuCode);
      return familyByCode.get(code)?.has(mid);
    });
    if (byCode) return { order: byCode, by: "productCode" };
    return { order: null, by: null };
  };

  // Every Deckle already named on a Slitting Job Card row, so the queue can
  // flag it -- "on <card>", or slit if that row / card is finished.
  const cards = await SlittingJobCard.find({ status: { $in: ["allocated", "completed"] } })
    .select("slittingJobCardId machineName operatorName status slittingLog")
    .lean();
  const deckleCard = new Map();
  for (const c of cards) {
    for (const lr of c.slittingLog || []) {
      const k = String(lr.deckleStockId || "");
      if (!k) continue;
      const run = lr.status === "done" || c.status === "completed";
      const prev = deckleCard.get(k);
      // An open (unrun) allocation wins over a finished one.
      if (!prev || (prev.run && !run)) {
        deckleCard.set(k, {
          slittingJobCardId: c.slittingJobCardId,
          machineName: c.machineName || "—",
          operatorName: c.operatorName || "—",
          run,
        });
      }
    }
  }

  const rows = reels.map((reel) => {
    const { order, by } = orderForReel(reel);
    const card = deckleCard.get(String(reel._id)) || null;
    const cure = deckleCuring(reel);
    return {
      deckleStockId: String(reel._id),
      rollId: reel.rollId || "—",
      productCode: trim(reel.material?.productCode || reel.material?.skuCode) || "—",
      mtrs: round2(Number(reel.reelMtrs) || 0),
      size: reel.size || "—",
      location: reel.location || "—",
      // Advisory: a Deckle can be allocated while it cures, but not run.
      curing: !cure.cured,
      curingUntilLabel: cure.curedAt && !cure.cured ? curingWhenLabel(cure.curedAt) : "",
      hotMelt: cure.hotMelt,
      order: order
        ? {
            _id: String(order._id),
            lotNo: order.lotNo || "—",
            clientOrderNo: order.poNumber || "—",
            clientName: order.userId?.clientName || order.userId?.userName || "—",
          }
        : null,
      matchedBy: by,
      card,
      // Deckle-scoped: the allocation page cuts exactly the Deckle named here,
      // never "the order". Every Deckle row therefore carries its own stock id.
      allocateHref: order
        ? `/sachiko/slitting/allocate/${order._id}?deckle=${reel._id}`
        : null,
    };
  });

  // A Deckle already sitting on an open (not yet run) card has moved to that
  // machine's queue -- routes/system/machine.js "/machine/:id/queue", which
  // also carries an Edit button back to this same Allocate page. Keeping it
  // listed here too would just be the same job in two places, so only Deckles
  // still free to allocate (or re-allocatable after a completed card left
  // metres behind) belong in this queue.
  const visibleRows = rows.filter((r) => !(r.card && !r.card.run));

  visibleRows.sort((a, b) =>
    a.location.localeCompare(b.location) || a.rollId.localeCompare(b.rollId),
  );

  // Club same Product Code + Size together -- these are interchangeable for
  // slitting, so the queue shows one group with one "Slit" action rather than
  // a separate row (and separate button) per physical Deckle. The dialog it
  // opens is where the planner actually picks which Deckle to cut.
  const groupMap = new Map();
  for (const r of visibleRows) {
    const key = `${r.productCode}::${r.size}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        _id: key,
        isGroup: true,
        productCode: r.productCode,
        size: r.size,
        deckleCount: 0,
        totalMtrs: 0,
        anyCuring: false,
        _children: [],
      });
    }
    const g = groupMap.get(key);
    g.deckleCount += 1;
    g.totalMtrs = round2(g.totalMtrs + r.mtrs);
    if (r.curing) g.anyCuring = true;
    g._children.push({ ...r, isGroup: false, _id: r.deckleStockId });
  }
  const groups = [...groupMap.values()].sort(
    (a, b) => a.productCode.localeCompare(b.productCode) || String(a.size).localeCompare(String(b.size)),
  );

  res.render("inventory/masters/slittingQueue.ejs", {
    title: "Deckle Slitting",
    CSS: "tableDisp.css",
    JS: false,
    rows: groups,
    notification: req.flash("notification"),
  });
});

// ---- Slitting WIP: cards actually running on a machine right now ----------
// Deckle Slitting above only lists Deckles still free to allocate; an
// allocated-but-not-yet-started card sits on its machine's own queue --
// routes/system/machine.js "/machine/:id/queue", where the operator starts
// it. This page is read-only and scoped narrower still: only cards with a
// row the operator has actually punched Start on (and not yet Stopped) --
// i.e. physically running on the floor right now, not merely queued.
router.get("/slitting/wip", requireSlittingView, async (req, res) => {
  const rows = (await buildSlittingQueueRows({})).filter((r) => r.running);
  rows.sort(
    (a, b) => a.machineName.localeCompare(b.machineName) || a.slittingJobCardId.localeCompare(b.slittingJobCardId),
  );

  res.render("inventory/masters/slittingWip.ejs", {
    title: "Slitting WIP",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    notification: req.flash("notification"),
  });
});

// ---- Allocation: the planner fixes ONE Deckle's job up front --------------
// Deckle-scoped. The Slitting Queue links here with ?deckle=<stockId>; this
// page allocates that one Deckle -- machine, operator, helper, its web width,
// the metres to run off it, the length per finished roll and the A..G knife
// layout. One Deckle == one SlittingJobCard, and once saved that card sits on
// the chosen machine's queue. The order's OTHER Deckles have their own cards
// and are only shown here for context, never edited from this page.
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

  const deckleStockId = trim(req.query.deckle);
  if (!mongoose.isValidObjectId(deckleStockId)) {
    req.flash("notification", "Open Allocate from Deckle Slitting so it knows which Deckle to cut.");
    return res.redirect("/sachiko/slitting/queue");
  }

  const deckles = await deckleOptionsFor(pending);
  if (!deckles.length) {
    req.flash("notification", "No Deckle stock left to slit for this order.");
    return res.redirect("/sachiko/slitting/queue");
  }
  const target = deckles.find((d) => d._id === String(deckleStockId));
  if (!target) {
    req.flash("notification", "That Deckle is no longer available to slit for this order.");
    return res.redirect("/sachiko/slitting/queue");
  }

  // The one open slitting card for THIS Deckle on this order, if it already
  // has one -- that (and only that) is what this page edits and prefills from.
  const scopedCard = await SlittingJobCard.findOne({
    pendingProductionId: pending._id,
    status: "allocated",
    "slittingLog.0.deckleStockId": new mongoose.Types.ObjectId(String(deckleStockId)),
  }).lean();

  const [machines, operators, helpers] = await Promise.all([
    Machine.find({ machineType: SLITTING_MACHINE_RE }).populate("location").sort({ machineName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
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

  // Machine / operator / helper are prefilled ONLY when THIS Deckle already
  // has a card (re-opening its allocation). A fresh Deckle starts blank --
  // another Deckle's crew is never carried over.
  const crew = {
    machineId: String(scopedCard?.machineId || ""),
    operatorId: String(scopedCard?.operatorId || ""),
    helperId: String(scopedCard?.helperId || ""),
  };

  const previewCardId = scopedCard ? scopedCard.slittingJobCardId : await previewSlittingId();
  const scopedRow = (scopedCard?.slittingLog || [])[0] || null;

  // Every other Deckle clubbed with this one on the Slitting Queue (same
  // Product Code + Size) -- context only, same as the Slitting Queue's
  // "Choose Deckle" dialog this page was opened from.
  const groupDeckles = deckles
    .filter((d) => d.size === target.size)
    .map((d) => ({
      _id: d._id,
      rollId: d.rollId,
      reelMtrs: d.reelMtrs,
      location: d.location,
      lotNo: d.lotNo,
      curing: d.curing,
      isTarget: d._id === target._id,
    }));

  res.render("inventory/masters/slittingAllocation.ejs", {
    title: "Slitting Allocation",
    CSS: false,
    JS: false,
    order,
    // The one Deckle this page allocates. Fixed -- the field is not a picker.
    targetDeckle: {
      _id: target._id,
      rollId: target.rollId,
      reelMtrs: target.reelMtrs,
      size: target.size,
      location: target.location,
      productCode: target.productCode,
      ownOrder: target.ownOrder,
      curing: target.curing,
    },
    groupDeckles,
    cutSlots: CUT_SLOTS,
    previewCardId,
    machines: machines.map((m) => ({
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "",
      locationName: m.location?.locationName || "",
    })),
    operators: operators.map((e) => ({ _id: String(e._id), empName: e.empName })),
    helpers: helpers.map((e) => ({ _id: String(e._id), empName: e.empName })),
    crew,
    // This Deckle's existing allocation, if any -- seeds the row and flips the
    // button to "Update".
    existing: scopedCard
      ? {
          slittingJobCardId: scopedCard.slittingJobCardId || "",
          row: {
            deckleStockId: String(scopedRow?.deckleStockId || ""),
            deckleId: scopedRow?.deckleId || "",
            width: scopedRow?.width ?? null,
            plannedMeter: scopedRow?.plannedMeter ?? null,
            plannedRunningMeter: scopedRow?.plannedRunningMeter ?? null,
            cuts: Object.fromEntries((scopedRow?.cuts || []).map((c) => [c.slot, c.width])),
          },
        }
      : null,
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

    // Deckle-scoped: this page allocates exactly the one Deckle it was opened
    // for (?deckle=<stockId>, echoed back in the body). One row, that Deckle.
    const scopeDeckleId = trim(b.deckleStockId);
    if (!mongoose.isValidObjectId(scopeDeckleId)) {
      return fail("Reload the allocation from Deckle Slitting.");
    }

    const rawRows = Array.isArray(b.rows) ? b.rows : [];
    if (!rawRows.length) return fail("Fill in the Deckle's layout.");
    if (rawRows.length > 1) return fail("This page allocates one Deckle at a time.");
    if (String(rawRows[0]?.deckleStockId || "") !== scopeDeckleId) {
      return fail("Reload the allocation from Deckle Slitting.");
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

    // A Deckle can only be slit against an order of its own Product Code
    // (brand variants included) -- the finished rolls take the Deckle's code,
    // so a reel of a genuinely different code would mis-name the whole run.
    const orderCode = trim(pending.itemId?.productCode || pending.itemId?.skuCode);
    const codeRe = productCodeFamilyRe(orderCode);
    if (codeRe) {
      const foreign = reels.find((r) => {
        const code = trim(r.material?.productCode || r.material?.skuCode);
        return code && !codeRe.test(code);
      });
      if (foreign) {
        const code = trim(foreign.material?.productCode || foreign.material?.skuCode);
        return fail(
          `Deckle "${foreign.rollId}" is Product Code ${code} — this order is ${orderCode}. Only ${orderCode} Deckles can be slit here.`,
        );
      }
    }

    // One Deckle == one card. Re-opening this page for a Deckle that already
    // has an open card updates THAT card in place (so it keeps its id and its
    // spot on the operator's queue); a Deckle with no open card yet gets a
    // fresh one. The order's other Deckles' cards are never read or touched
    // here -- they belong to their own Allocate pages.
    const scopedCard = await SlittingJobCard.findOne({
      pendingProductionId: pending._id,
      status: "allocated",
      "slittingLog.0.deckleStockId": new mongoose.Types.ObjectId(scopeDeckleId),
    });

    // A card already run is finished work -- its stock has moved and it is
    // never touched here. Its Deckle may legitimately be allocated again
    // (a part-drawn reel still carrying metres), which is why this only
    // looks at the open card above, not the completed ones.
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
      allocatedBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
    };

    const submissionToken = trim(b.submissionToken) || undefined;
    if (submissionToken && (await SlittingJobCard.exists({ submissionToken }))) {
      // A resubmit of the same loaded page -- the first one already created
      // this Deckle's card. Don't make a second.
      return res.json({ success: true, redirect: "/sachiko/slitting/queue" });
    }

    const r = rows[0];
    const deckleId = reelById.get(scopeDeckleId)?.rollId || "";
    let card;
    let wasUpdate = false;

    if (scopedCard) {
      wasUpdate = true;
      Object.assign(scopedCard, shared);
      const prior = (scopedCard.slittingLog || [])[0];
      scopedCard.slittingLog = [{
        ...r,
        deckleId,
        // The token is what makes this card's Stop idempotent, so it is kept
        // across a re-allocation rather than re-minted -- a Stop already in
        // flight must still match.
        rowToken: prior?.rowToken || randomUUID(),
        status: "pending",
      }];
      await scopedCard.save();
      card = scopedCard;
    } else {
      card = await SlittingJobCard.create({
        ...shared,
        slittingJobCardId: await generateSlittingId(),
        submissionToken,
        date: b.date ? new Date(b.date) : new Date(),
        slittingLog: [{ ...r, deckleId, rowToken: randomUUID(), status: "pending" }],
      });
    }

    const summary =
      `slitting job ${card.slittingJobCardId} for Deckle ${deckleId || scopeDeckleId} `
      + `on ${machine.machineName} for ${operator.empName}`;

    res.locals.auditDescription =
      `${wasUpdate ? "Updated" : "Allocated"} ${summary} (order ${pending.lotNo || pending._id}).`;
    req.flash(
      "notification",
      `${wasUpdate ? "Updated" : "Allocated"} ${card.slittingJobCardId} — Deckle ${deckleId || scopeDeckleId} is on ${machine.machineName}'s queue.`,
    );
    res.json({ success: true, redirect: "/sachiko/slitting/queue" });
  } catch (err) {
    console.error("SLITTING ALLOCATION ERROR:", err);
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      return res.json({ success: true, redirect: "/sachiko/slitting/queue" });
    }
    res.status(500).json({ success: false, message: "Failed to save the slitting allocation." });
  }
});

// ---- Bulk allocation, step 1: the form ------------------------------------
// The queue's "Choose Deckle" dialog only picks which Deckles to allocate
// (each ticked by default); Machine, Operator, Helper and the A..G knife
// layout are entered here instead, once, and applied to every one of them.
// ?items= is a JSON array of {deckleStockId, pendingId} pairs built by that
// dialog from the Deckles it already has loaded -- re-fetched and
// re-validated here rather than trusted, same spirit as the single-Deckle
// Allocate page re-deriving everything from ids.
router.get("/slitting/bulk-allocate", requireSlittingPlanner, async (req, res) => {
  let items;
  try {
    items = JSON.parse(req.query.items || "[]");
  } catch {
    items = [];
  }
  if (!Array.isArray(items)) items = [];

  const seen = new Set();
  const pairs = [];
  for (const it of items) {
    const deckleStockId = trim(it?.deckleStockId);
    const pendingId = trim(it?.pendingId);
    if (!mongoose.isValidObjectId(deckleStockId) || !mongoose.isValidObjectId(pendingId)) continue;
    if (seen.has(deckleStockId)) continue;
    seen.add(deckleStockId);
    pairs.push({ deckleStockId, pendingId });
  }
  if (!pairs.length) {
    req.flash("notification", "Choose at least one Deckle from Deckle Slitting.");
    return res.redirect("/sachiko/slitting/queue");
  }

  const [reels, pendings, machines, operators, helpers] = await Promise.all([
    MaterialStock.find({ _id: { $in: pairs.map((p) => p.deckleStockId) } })
      .populate({ path: "material", select: "productCode skuCode adhesive adhesive2" })
      .lean(),
    PendingProduction.find({ _id: { $in: pairs.map((p) => p.pendingId) } })
      .populate({ path: "itemId", select: "productCode skuCode" })
      .lean(),
    Machine.find({ machineType: SLITTING_MACHINE_RE }).populate("location").sort({ machineName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "HELPER" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
  ]);
  const reelById = new Map(reels.map((r) => [String(r._id), r]));
  const pendingById = new Map(pendings.map((p) => [String(p._id), p]));

  // Deckles that no longer exist or resolve are dropped quietly here (the
  // POST re-validates for real and fails loudly if any survivor turns out
  // bad) -- reloading the queue and re-picking is the recovery either way.
  const deckles = pairs
    .map(({ deckleStockId, pendingId }) => {
      const reel = reelById.get(deckleStockId);
      const pending = pendingById.get(pendingId);
      if (!reel || !pending) return null;
      const cure = deckleCuring(reel);
      return {
        deckleStockId,
        pendingId,
        rollId: reel.rollId || "—",
        reelMtrs: round2(Number(reel.reelMtrs) || 0),
        size: reel.size || "",
        location: reel.location || "",
        lotNo: reel.lotNo || "",
        productCode: reel.material?.productCode || reel.material?.skuCode || pending.itemId?.productCode || "",
        curing: !cure.cured,
        curingUntilLabel: cure.curedAt && !cure.cured ? curingWhenLabel(cure.curedAt) : "",
        hotMelt: cure.hotMelt,
      };
    })
    .filter(Boolean);

  if (!deckles.length) {
    req.flash("notification", "None of the chosen Deckles are available any more — reload Deckle Slitting.");
    return res.redirect("/sachiko/slitting/queue");
  }

  res.render("inventory/masters/slittingBulkAllocation.ejs", {
    title: "Bulk Slitting Allocation",
    CSS: false,
    JS: false,
    deckles,
    cutSlots: CUT_SLOTS,
    machines: machines.map((m) => ({
      _id: String(m._id),
      machineName: m.machineName,
      locationName: m.location?.locationName || "",
    })),
    operators: operators.map((e) => ({ _id: String(e._id), empName: e.empName })),
    helpers: helpers.map((e) => ({ _id: String(e._id), empName: e.empName })),
    notification: req.flash("notification"),
  });
});

// ---- Bulk allocation, step 2: the submit ----------------------------------
// A planner ticks several Deckles clubbed under the same Product Code + Size
// (each may belong to a different order -- the dialog sends each Deckle's own
// pendingId back with it) and allocates them all at once: one machine,
// operator and helper, and one A..G knife layout applied to every Deckle,
// each running its own full remaining metres. One SlittingJobCard per
// Deckle, same as opening the single-Deckle Allocate page for each in turn --
// a Deckle that already has an open card is updated in place exactly like
// re-opening its own Allocate page would.
router.post("/slitting/bulk-allocate", requireAuth, requireSlittingPlanner, createLimiter, async (req, res) => {
  const fail = (message) => res.status(400).json({ success: false, message });
  try {
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

    const plannedRunningMeter = numOrNull(b.plannedRunningMeter);
    if (!(plannedRunningMeter > 0)) return fail("Enter the R. Meter for each finished roll.");

    const cuts = CUT_SLOTS.map((slot) => ({ slot, width: numOrNull(b.cuts?.[slot]) })).filter((c) => c.width !== null);
    if (!cuts.length) return fail("Enter at least one roll width (A–G).");
    if (cuts.some((c) => !(c.width > 0))) return fail("Roll widths must be greater than zero.");
    const cutTotal = round2(cuts.reduce((n, c) => n + c.width, 0));

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return fail("Tick at least one Deckle to allocate.");

    // Validate every ticked Deckle up front -- all or nothing, same as the
    // single-Deckle Allocate page's "check the whole plan before writing any
    // of it" rule.
    const plans = [];
    const seen = new Set();
    for (const item of items) {
      const deckleStockId = trim(item?.deckleStockId);
      const pendingId = trim(item?.pendingId);
      if (!mongoose.isValidObjectId(deckleStockId) || !mongoose.isValidObjectId(pendingId)) {
        return fail("Reload Deckle Slitting and try again.");
      }
      if (seen.has(deckleStockId)) continue;
      seen.add(deckleStockId);

      const pending = await PendingProduction.findById(pendingId)
        .populate({ path: "itemId", select: "productCode skuCode" })
        .populate({ path: "userId", select: "clientName userName" })
        .lean();
      if (!pending) return fail("One of the ticked Deckles' orders no longer exists — reload the page.");

      const reel = await MaterialStock.findById(deckleStockId)
        .populate({ path: "material", select: "productCode skuCode" })
        .lean();
      if (!reel) return fail("One of the ticked Deckles no longer exists — reload the page.");

      const available = round2(Number(reel.reelMtrs) || 0);
      if (!(available > 0)) return fail(`Deckle "${reel.rollId}" has no metres left to slit.`);

      const width = numOrNull(reel.size);
      if (width !== null && cutTotal > width) {
        return fail(`Deckle "${reel.rollId}": roll widths total ${cutTotal} mm but its web is only ${width} mm.`);
      }

      if (!trim(reel.location)) return fail(`Deckle "${reel.rollId}" has no location on it.`);

      const code = trim(reel.material?.productCode || reel.material?.skuCode);
      if (!code) return fail(`Deckle "${reel.rollId}" has no Product Code on its Label Stock — it cannot be slit.`);

      const orderCode = trim(pending.itemId?.productCode || pending.itemId?.skuCode);
      const codeRe = productCodeFamilyRe(orderCode);
      if (codeRe && !codeRe.test(code)) {
        return fail(
          `Deckle "${reel.rollId}" is Product Code ${code} — its order is ${orderCode}. Only ${orderCode} Deckles can be slit against it.`,
        );
      }

      plans.push({ pending, reel, width, available });
    }

    const allocatedBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const cardIds = [];

    for (const { pending, reel, width, available } of plans) {
      const deckleStockId = String(reel._id);
      const scopedCard = await SlittingJobCard.findOne({
        pendingProductionId: pending._id,
        status: "allocated",
        "slittingLog.0.deckleStockId": new mongoose.Types.ObjectId(deckleStockId),
      });

      const shared = {
        status: "allocated",
        pendingProductionId: pending._id,
        machineId: machine._id,
        machineName: machine.machineName || "",
        operatorId: operator._id,
        operatorName: operator.empName || "",
        helperId: helper?._id,
        helperName: helper?.empName || "",
        clientOrderNo: pending.poNumber || "",
        clientName: pending.userId?.clientName || pending.userId?.userName || "",
        productCode: pending.itemId?.productCode || pending.itemId?.skuCode || "",
        lotNo: pending.lotNo || "",
        location: reel.location,
        allocatedBy,
      };

      const row = {
        deckleStockId,
        width,
        cuts,
        plannedMeter: available,
        plannedRunningMeter: round2(plannedRunningMeter),
        status: "pending",
      };

      let card;
      if (scopedCard) {
        Object.assign(scopedCard, shared);
        const prior = (scopedCard.slittingLog || [])[0];
        scopedCard.slittingLog = [{ ...row, deckleId: reel.rollId || "", rowToken: prior?.rowToken || randomUUID() }];
        await scopedCard.save();
        card = scopedCard;
      } else {
        card = await SlittingJobCard.create({
          ...shared,
          slittingJobCardId: await generateSlittingId(),
          date: new Date(),
          slittingLog: [{ ...row, deckleId: reel.rollId || "", rowToken: randomUUID() }],
        });
      }
      cardIds.push(card.slittingJobCardId);
    }

    res.locals.auditDescription =
      `Bulk-allocated ${cardIds.length} slitting job${cardIds.length === 1 ? "" : "s"} `
      + `(${cardIds.join(", ")}) on ${machine.machineName} for ${operator.empName}.`;
    req.flash(
      "notification",
      `Allocated ${cardIds.length} Deckle${cardIds.length === 1 ? "" : "s"} to ${machine.machineName}'s queue.`,
    );
    res.json({ success: true, redirect: "/sachiko/slitting/queue" });
  } catch (err) {
    console.error("SLITTING BULK ALLOCATION ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save the bulk slitting allocation." });
  }
});

// ---- The operator's card ---------------------------------------------------
// Declared ahead of the "/:cardId" route below -- Express matches in
// declaration order, and "view" would otherwise be read as a card id.
router.get("/slitting/jobcard/view", requireSlittingView, async (req, res) => {
  const cards = await SlittingJobCard.find().sort({ createdAt: -1 }).lean();

  res.render("inventory/masters/slittingJobCardView.ejs", {
    title: "Slitting Logs",
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
    ? await MaterialStock.find({ _id: { $in: stockIds } })
        .select("rollId reelMtrs location createdAt")
        .populate({ path: "material", select: "adhesive adhesive2" })
        .lean()
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
      rows: (card.slittingLog || []).map((r, i) => {
        const reel = reelById.get(String(r.deckleStockId));
        const cure = deckleCuring(reel);
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
          // Curing gate -- Start / Stop stay locked until the adhesive has
          // cured (6 h after lamination), unless it's a hot-melt build.
          curing: {
            cured: cure.cured,
            hotMelt: cure.hotMelt,
            curedAt: cure.curedAt ? cure.curedAt.toISOString() : null,
            curedAtLabel: cure.curedAt ? curingWhenLabel(cure.curedAt) : "",
          },
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

    // Curing gate: the adhesive must have cured before the web is run.
    const cureReel = await MaterialStock.findById(row.deckleStockId)
      .select("rollId createdAt")
      .populate({ path: "material", select: "adhesive adhesive2" })
      .lean();
    if (cureReel) {
      const cure = deckleCuring(cureReel);
      if (!cure.cured) {
        return res.status(400).json({
          success: false,
          message: curingBlockedMessage(cureReel.rollId || row.deckleId || "this reel", cure.curedAt),
        });
      }
    }

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
      .populate({ path: "material", select: "productCode skuCode adhesive adhesive2" })
      .lean();
    if (!reel) return fail("That Deckle no longer exists.");

    // Curing gate: refuse to slit a web whose adhesive has not cured (6 h
    // after lamination), unless it's a hot-melt build.
    const cure = deckleCuring(reel);
    if (!cure.cured) {
      return fail(curingBlockedMessage(reel.rollId || row.deckleId || "this reel", cure.curedAt));
    }

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
