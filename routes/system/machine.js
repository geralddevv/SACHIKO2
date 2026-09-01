import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import Employee from "../../models/hr/employee_model.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import MaterialStockLog from "../../models/inventory/materialStockLog.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";
import { normalizeRollId, extractScannedRollId, findScannedReel, generateDeckleId } from "../../utils/rollId.js";
import { requiredLayersFor, LAYER_META, POOL_MODELS, pickStockIds, getEligibleRawMaterials } from "../../utils/labelStockProduction.js";
import { resolveActualLabelStock, resolveLabelStockCombinations } from "../../utils/labelStockVariant.js";

const router = express.Router();

// Whether an order has the material it needs actually set aside to start.
// Assign Production stops at recording reel picks per raw-material layer
// (PendingProduction.allottedLayers -- it no longer laminates a Deckle on
// submit, see the doc comment above #rawLayersGrid in
// assignProduction.ejs), so "every layer this SKU's recipe calls for holds
// at least one allotted reel" is what readiness means now. allottedRollIds
// (a finished Deckle roll ticked on) still counts on its own, for orders
// assigned through the older flow. Used by the queue's Start button and by
// both job-card guards, so all three agree.
export function hasStartableAllotment({ rollType, allottedLayers, allottedRollIds }) {
  if (Array.isArray(allottedRollIds) && allottedRollIds.length) return true;
  const required = requiredLayersFor(rollType);
  return required.length > 0 && required.every((key) => pickStockIds(allottedLayers?.[key]).length > 0);
}

// Generate a sequential id of the form `SP | <CODE> | 000001`, matching the
// convention already used for Label Stock/Job Card ids in
// routes/sachiko/sachiko_route.js's generateId/previewId.
async function generateId(key, code) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | ${code} | ${String(counter.seq).padStart(6, "0")}`;
}

export async function previewId(key, code) {
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const nextSeq = Number(counter?.seq || 0) + 1;
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const trim = (value) => String(value ?? "").trim();

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// A browser normally contributes one usage row per physical reel, but POST
// bodies are not a trusted source. Collapse repeated ids before they reach a
// stock mutation so one reel can never receive two competing deductions (or
// two outward logs) in the same job card.
const consolidateUsageRows = (rows, amountKey) => {
  const byStockId = new Map();
  for (const row of rows) {
    const stockId = trim(row?.stockId);
    const amount = Number(row?.[amountKey]);
    if (!stockId) continue;
    const remainingKg = row?.remainingKg !== undefined && Number.isFinite(Number(row.remainingKg)) ? Number(row.remainingKg) : undefined;
    const existing = byStockId.get(stockId);
    if (!existing) {
      byStockId.set(stockId, { stockId, [amountKey]: Number.isFinite(amount) ? amount : 0, remainingKg });
    } else {
      existing[amountKey] = round2(existing[amountKey] + (Number.isFinite(amount) ? amount : 0));
      if (remainingKg !== undefined) existing.remainingKg = remainingKg;
    }
  }
  return [...byStockId.values()].filter((r) => r[amountKey] > 0 || r.remainingKg !== undefined);
};

// ----------------------------------Machine Master---------------------------------->

// This router is mounted on the bare "/sachiko" prefix with no role gate (see
// server.js for why), so every route below carries its own. The machine
// master -- adding, editing and deleting machines -- stays with management;
// the queue and job card pages additionally admit shopfloor operators.
const requireMachineMaster = requireRole(["proprietor", "admin", "hod"]);
const requireMachineFloor = requireRole(["proprietor", "admin", "hod", "operator"]);

router.get("/form/machine", requireMachineMaster, async (req, res) => {
  const [locations, machines] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    Machine.find().populate("location").sort({ machineName: 1 }).lean(),
  ]);
  res.render("inventory/masters/machineMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Machine Master",
    locations,
    machines,
    notification: req.flash("notification"),
  });
});

router.post("/form/machine", requireAuth, requireMachineMaster, createLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const machineWidth = Number(req.body.machineWidth);
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();

    if (!machineName) {
      return res.status(400).json({ success: false, message: "Machine name is required." });
    }
    if (!machineWidth || machineWidth <= 0) {
      return res.status(400).json({ success: false, message: "Machine width is required." });
    }
    if (!locationId) {
      return res.status(400).json({ success: false, message: "Location is required." });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location" });
    }

    const alreadyExists = await Machine.exists({ machineName, location: locationId });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location" });
    }

    await Machine.create({ machineName, machineWidth, location: locationId, machineType });
    res.locals.auditDescription = `Created machine "${machineName}" at "${locationDoc.locationName}"`;
    req.flash("notification", "Machine created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/machine" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.get("/api/machines", requireMachineMaster, async (req, res) => {
  const machines = await Machine.distinct("machineName");
  res.json([...new Set(machines.filter(Boolean))].sort());
});

router.put("/api/machines/:id", requireAuth, requireMachineMaster, updateLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const machineWidth = Number(req.body.machineWidth);
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();

    if (!machineName) {
      return res.status(400).json({ success: false, message: "Machine name is required." });
    }
    if (!machineWidth || machineWidth <= 0) {
      return res.status(400).json({ success: false, message: "Machine width is required." });
    }
    if (!locationId) {
      return res.status(400).json({ success: false, message: "Location is required." });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const alreadyExists = await Machine.exists({
      machineName,
      location: locationId,
      _id: { $ne: req.params.id },
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location." });
    }

    const updated = await Machine.findByIdAndUpdate(
      req.params.id,
      { machineName, machineWidth, location: locationId, machineType },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Machine not found." });
    }

    res.locals.auditDescription = `Updated machine "${machineName}" at "${locationDoc.locationName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/machines/:id", requireAuth, requireMachineMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await Machine.findById(req.params.id).select("machineName").lean();
    await Machine.findByIdAndDelete(req.params.id);
    res.locals.auditDescription = `Deleted machine "${existing?.machineName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE MACHINE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete machine." });
  }
});

// ----------------------------------Machine Production Queue---------------------------------->
// Overview of every machine with a pending-order count, linking through to
// each machine's own queue detail page below.
router.get("/machine/queue", requireMachineFloor, async (req, res) => {
  const machines = await Machine.find().populate("location").sort({ machineName: 1 }).lean();

  // producedAt: null keeps finished jobs off the queue (matches unset too).
  const queuedJobs = await buildQueueRows({ assignedMachineId: { $ne: null }, producedAt: null });
  const jobsByMachine = new Map();
  queuedJobs.forEach((job) => {
    if (!job.machineId) return;
    if (!jobsByMachine.has(job.machineId)) jobsByMachine.set(job.machineId, []);
    jobsByMachine.get(job.machineId).push({
      _id: job._id,
      productCode: job.productCode,
      quantity: job.quantity,
      rolls: job.rolls,
      balanceRolls: job.balanceRolls,
      producedRolls: job.producedRolls,
      rollIds: job.allottedRollDetails.map((r) => r.rollId).filter(Boolean),
      clientName: job.clientName,
    });
  });

  // Operator <-> Machine link is by profile code, matching the auto-select on
  // the Assign Production form: an employee's empProfileCode is set to the
  // machine's name they operate. Keyed by code + location too, since the same
  // machine name/code can exist at more than one location and an operator
  // only runs the machine at their own location.
  const operators = await Employee.find(
    { isActive: true, empProfile: "OPERATOR", empProfileCode: { $exists: true, $ne: "" } },
    "empName empProfileCode empLoc",
  ).lean();
  const operatorByProfileCodeAndLocation = new Map(
    operators.map((emp) => [
      `${String(emp.empProfileCode).trim().toUpperCase()}||${normalizeLocationName(emp.empLoc)}`,
      emp.empName,
    ]),
  );

  const rows = machines.map((m) => {
    const key = `${String(m.machineName).trim().toUpperCase()}||${normalizeLocationName(m.location?.locationName)}`;
    const jobs = jobsByMachine.get(String(m._id)) || [];
    return {
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "—",
      locationName: m.location?.locationName || "—",
      operatorName: operatorByProfileCodeAndLocation.get(key) || "—",
      pendingCount: jobs.length,
      jobs,
    };
  });

  res.render("inventory/masters/machineQueueList.ejs", {
    title: "Machine Queues",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Operator Work Queue---------------------------------->
// An operator's personal worklist: every order assigned to *them* (by
// PendingProduction.operatorId, set at Assign Production), grouped under the
// machine each job sits on. This is where operators land straight after
// login, so it reads their own empObjId off the session rather than a URL
// param.
// Extracted so the JSON operator API's GET /queue can reuse exactly this
// grouping logic instead of re-deriving it -- see routes/api/operatorApi.js.
export async function buildOperatorQueue({ empObjId, empName, empNickName, empLoc }) {
  const operatorObjId = empObjId;

  const rows =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await buildQueueRows({ operatorId: operatorObjId, assignedMachineId: { $ne: null }, producedAt: null })
      : [];

  const machineIds = [...new Set(rows.map((r) => r.machineId).filter(Boolean))];
  const machines = machineIds.length
    ? await Machine.find({ _id: { $in: machineIds } }).populate("location").lean()
    : [];
  const machineMap = new Map(machines.map((m) => [String(m._id), m]));

  const groupsMap = new Map();
  rows.forEach((row) => {
    if (!groupsMap.has(row.machineId)) groupsMap.set(row.machineId, []);
    groupsMap.get(row.machineId).push(row);
  });

  const groups = [...groupsMap.entries()]
    .map(([machineId, jobs]) => {
      const m = machineMap.get(machineId);
      return {
        machineId,
        machineName: m?.machineName || "—",
        machineType: m?.machineType || "—",
        locationName: m?.location?.locationName || "—",
        jobs,
      };
    })
    .sort((a, b) => String(a.machineName).localeCompare(String(b.machineName)));

  // Badge on the Maintenance tab: the operator's own tickets still being
  // worked on, so a raised problem stays visible from the queue page too.
  const openMaintenanceCount =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.countDocuments({
          raisedById: operatorObjId,
          status: { $in: ["OPEN", "IN PROGRESS"] },
        })
      : 0;

  return {
    operatorName: empName || "",
    // Additive on purpose: the EJS operator queue page keeps rendering
    // operatorName, while the mobile app greets the operator by the short
    // name they actually go by. Falls back to the full name so an operator
    // with no nick name set still reads sensibly.
    operatorNickName: empNickName || empName || "",
    operatorLocation: empLoc || "",
    groups,
    totalJobs: rows.length,
    openMaintenanceCount,
  };
}

router.get("/operator/queue", requireRole(["operator"]), async (req, res) => {
  const authUser = req.session?.authUser;
  const queue = await buildOperatorQueue({
    empObjId: authUser?.empObjId,
    empName: authUser?.empName,
    empNickName: authUser?.empNickName,
    empLoc: authUser?.empLoc,
  });

  res.render("inventory/masters/operatorQueue.ejs", {
    title: "Work Queue",
    CSS: "tableDisp.css",
    JS: false,
    ...queue,
    notification: req.flash("notification"),
  });
});

// Shared by the per-machine queue page, the queue overview's card view and the
// job card form's prefill lookup. Takes a match filter rather than a single
// id so the overview can build every machine's jobs in one pass instead of
// one round of queries per machine.
export async function buildQueueRows(match) {
  const pending = await PendingProduction.find(match)
    .populate({
      path: "itemId",
      select: "productCode skuCode rollType facestock facestock2 adhesive adhesive2 releaseLiner releaseLiner2",
    })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .populate({ path: "userId", select: "clientName userName" })
    .sort({ assignedAt: 1 })
    .lean();

  // The exact rolls ticked on the Assign Production form, so the job card can
  // name the physical rolls rather than just a count.
  const rollIds = pending.flatMap((p) => (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : []));
  const rollDocs = rollIds.length
    ? await MaterialStock.find({ _id: { $in: rollIds } }).select("rollId reelMtrs location").lean()
    : [];
  const rollMap = new Map(rollDocs.map((r) => [String(r._id), r]));

  // Raw-material layer picks (Facestock/Adhesive/Release Liner, ...) recorded
  // on the assign form -- kept as { pool, stockIds } on each order (see
  // models/inventory/pendingProduction.js's allottedLayers, one or more
  // reels per layer), so the queue always re-reads the live rollId/reelMtrs
  // off the actual pool doc(s) rather than trusting a snapshot. Batched per
  // pool across every order in this match, same pattern as rollMap above.
  const stockIdsByPool = {};
  for (const p of pending) {
    for (const pick of Object.values(p.allottedLayers || {})) {
      if (!pick?.pool) continue;
      (stockIdsByPool[pick.pool] ||= []).push(...pickStockIds(pick));
    }
  }
  const layerDocMaps = {};
  for (const [pool, ids] of Object.entries(stockIdsByPool)) {
    const { Model } = POOL_MODELS[pool];
    const docs = await Model.find({ _id: { $in: ids } })
      .select("rollId reelMtrs location size gsm make vendorSkuCode")
      .lean();
    layerDocMaps[pool] = new Map(docs.map((d) => [String(d._id), d]));
  }

  return pending.map((p) => {
    const item = p.itemId || {};
    const qty = Number(p.quantity) || 0;
    const balanceQty = Math.max(qty - (Number(p.dispatchedQuantity) || 0), 0);
    // The machine floor laminates one deckle per Production Log row, so the
    // job's target is the DECKLE count -- for a plain order that's its Qty,
    // for a deckle batch it's the planner-entered Deckle Qty (stored on the
    // batch as noOfRolls). A plain order's own noOfRolls is the sales order's
    // finished-roll count, a downstream slitting figure that never drives the
    // machine queue or the job card.
    const deckleTarget = p.isDeckleBatch
      ? (p.noOfRolls != null ? Number(p.noOfRolls) : null)
      : (p.quantity != null ? Number(p.quantity) : null);
    const rolls = deckleTarget;
    const allottedRolls = p.allottedRolls != null ? p.allottedRolls : null;
    // Rolls this order's Job Cards have already produced (POST /machine/
    // jobcard/form accumulates one per Production Log row). The balance is
    // what's still to run -- distinct from allotment: allottedRolls /
    // rollsStatus below still track how many reels the office set aside.
    const producedRolls = Number(p.producedRolls) || 0;
    const balanceRolls =
      rolls == null ? null : Math.max(rolls - producedRolls, 0);
    const rollsStatus =
      allottedRolls == null || rolls == null
        ? null
        : allottedRolls === rolls
        ? "match"
        : allottedRolls < rolls
        ? "short"
        : "over";

    const allottedRollDetails = (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : [])
      .map((rid) => rollMap.get(String(rid)))
      .filter(Boolean)
      .map((r) => ({
        rollId: r.rollId || "",
        reelMtrs: Number(r.reelMtrs) || 0,
        location: r.location || "",
      }))
      .sort((a, b) => a.reelMtrs - b.reelMtrs || String(a.rollId).localeCompare(String(b.rollId)));

    const runningMetersLabel =
      p.runningMeters != null ? `${Number(p.runningMeters).toLocaleString("en-IN")} kg` : "";

    // Per-layer allocation -- one row per raw-material layer this item's
    // recipe actually calls for (facestock/adhesive/releaseLiner, +2 more
    // for DOUBLE FACESTOCK/DOUBLE RELEASE), so "Facestock allotted, Adhesive
    // not" reads as its own line rather than collapsing into one Deckle
    // count. A layer can hold more than one picked reel (see pickStockIds),
    // so `reels` is a list -- `allocated` is true once at least one of them
    // still resolves to a real doc, which also silently drops any pick whose
    // doc since got deleted/emptied rather than showing it as garbage.
    const layerAllotments = requiredLayersFor(item.rollType).map((key) => {
      const meta = LAYER_META[key];
      const pick = p.allottedLayers?.[key];
      const reels = pick
        ? pickStockIds(pick)
            .map((sid) => layerDocMaps[pick.pool]?.get(sid))
            .filter(Boolean)
            .map((doc) => ({
              _id: String(doc._id),
              rollId: doc.rollId || "",
              reelMtrs: Number(doc.reelMtrs) || 0,
              location: doc.location || "",
              code: doc.vendorSkuCode || "",
              gsm: doc.gsm,
              size: doc.size || "",
              make: doc.make || "",
            }))
        : [];
      return {
        key,
        pool: meta.pool,
        label: meta.label,
        unit: meta.unit,
        allocated: reels.length > 0,
        reels,
      };
    });

    // Row highlight -- green once every raw-material layer this item's
    // recipe calls for is allotted (Facestock/Adhesive/Release Liner, ...),
    // red otherwise. Deliberately NOT the same thing as rollsStatus above
    // (Deckle reels produced vs. noOfRolls ordered): "Produce New Deckle"
    // only ever laminates one physical reel per Assign & Continue submission,
    // so an order needing 2+ rolls reads "short" on rollsStatus after the
    // very first run even though every layer feeding that run is fully
    // allocated -- material allocation, not roll count, is what says this
    // order is actually ready to run.
    const materialStatus = layerAllotments.length === 0
      ? null
      : layerAllotments.every((l) => l.allocated)
      ? "match"
      : "short";

    // Same allotment facts as materialStatus above, split per raw-material
    // pool (Facestock/Adhesive/Release Liner) instead of collapsed into one
    // yes/no -- DOUBLE FACESTOCK/DOUBLE RELEASE rollTypes call for 2 layers
    // out of the same pool (facestock+facestock2, or adhesive+adhesive2 /
    // releaseLiner+releaseLiner2), so "one of two allotted" needs its own
    // "partial" state distinct from "none" and "full".
    const poolStatus = (pool) => {
      const layers = layerAllotments.filter((l) => LAYER_META[l.key].pool === pool);
      if (layers.length === 0) return null;
      const allocatedCount = layers.filter((l) => l.allocated).length;
      if (allocatedCount === 0) return "none";
      if (allocatedCount === layers.length) return "full";
      return "partial";
    };
    const facestockStatus = poolStatus("facestock");
    const adhesiveStatus = poolStatus("adhesive");
    const releaseStatus = poolStatus("release");

    // The item's recipe, one row per layer it calls for, as
    // { tag: "Facestock" | "Adhesive" | "Release" (+ " 2" for a second
    // layer), code, gsm, size }. Drawn straight off the Label Stock's saved
    // facestock/adhesive/releaseLiner (+ *2) sub-docs -- Adhesive has no
    // size of its own.
    const POOL_TAG = { facestock: "Facestock", adhesive: "Adhesive", release: "Release" };
    const RECIPE_FIELDS = {
      facestock: { code: "facestockVendorSkuCode", gsm: "facestockGsm", size: "facestockSize" },
      adhesive: { code: "adhesiveVendorSkuCode", gsm: "adhesiveGsm", size: null },
      release: { code: "releaseLinerVendorSkuCode", gsm: "releaseLinerGsm", size: "releaseLinerSize" },
    };
    const recipe = requiredLayersFor(item.rollType).map((key) => {
      const meta = LAYER_META[key];
      const spec = item[meta.specField] || {};
      const f = RECIPE_FIELDS[meta.pool];
      return {
        tag: POOL_TAG[meta.pool] + (key.endsWith("2") ? " 2" : ""),
        code: spec[f.code] || "",
        gsm: f.gsm != null && spec[f.gsm] != null ? spec[f.gsm] : "",
        size: f.size ? spec[f.size] || "" : "",
      };
    });

    return {
      _id: String(p._id),
      machineId: String(p.assignedMachineId || ""),
      lotNo: p.lotNo || "—",
      productCode: item.productCode || item.skuCode || "—",
      paperSize: p.paperSize || "—",
      rollType: item.rollType || "—",
      deckleSize: p.deckleSize ?? null,
      runningMeters: p.runningMeters ?? null,
      // Free-text run spec set on Deckle Set (e.g. "1000 MTRS OF 5 ROLL") --
      // shown in place of the bare number where present, same as the Deckle
      // Queue / Assign Production pages.
      runningMetersText: p.runningMetersText || "",
      // Length of ONE deckle web, as typed into Deckle Set's "Per deckle"
      // input -- distinct from runningMeters above, which is the whole job's
      // finished length across every roll slit off that web (see the field
      // comments on models/inventory/pendingProduction.js). The operator app
      // runs against this one.
      deckleRunningMeters: p.deckleRunningMeters ?? null,
      // Which device is currently running this job, if any. Additive and
      // read only by the operator API's /queue, which turns it into a plain
      // "not you, and who" flag -- the web queue pages ignore it.
      runningOn: p.runningOn || null,
      deckleTarget: deckleTarget != null ? deckleTarget : null,
      rolls: rolls != null ? String(rolls) : "—",
      allottedRolls: allottedRolls != null ? String(allottedRolls) : "—",
      balanceRolls: balanceRolls != null ? String(balanceRolls) : "—",
      producedRolls,
      rollsStatus,
      materialStatus,
      facestockStatus,
      adhesiveStatus,
      releaseStatus,
      // Same rule as hasStartableAllotment(), but off the live-resolved
      // layerAllotments above -- so a pick whose reel doc has since been
      // deleted stops counting here too.
      canStart: materialStatus === "match" || allottedRollDetails.length > 0,
      quantity: qty,
      balanceQuantity: balanceQty,
      clientName: p.userId?.clientName || p.userId?.userName || "—",
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      allottedRollDetails,
      layerAllotments,
      recipe,
      materialReference: {
        facestockType: item.facestock?.facestockType || "",
        facestockFamily: item.facestock?.facestockFamily || "",
        adhesiveType: item.adhesive?.adhesiveType || "",
        releaseLinerType: item.releaseLiner?.releaseLinerType || "",
        runningMeters: runningMetersLabel,
        paperSize: p.paperSize || "",
      },
    };
  });
}

// Raw-material reels that ANY other still-open production order has actually
// started drawing on -- scanned + Start punched (liveMaterialInUse), or
// recorded as live-consumed (materialSwapLog, legacy). This is the exact
// "in use right now" signal the WIP Stock page shows (routes/stock/
// wipStock.js). A reel here is strictly off-limits to another job: the same
// physical reel can't feed two machines at once. Distinct from a mere paper
// allotment, which the shop floor is free to override by scanning something
// else.
//
// Returns { byStockId, byRollId } -- both Maps to { lotNo, machineName, pool }
// -- keyed by `${pool}|${stockId}` and by normalized rollId respectively.
export async function reelsInUseElsewhere(exceptPendingId) {
  const byStockId = new Map();
  const byRollId = new Map();

  const filter = { producedAt: null };
  if (mongoose.isValidObjectId(exceptPendingId)) filter._id = { $ne: exceptPendingId };

  const others = await PendingProduction.find(filter)
    .select("lotNo assignedMachineId liveMaterialInUse materialSwapLog")
    .lean();
  if (!others.length) return { byStockId, byRollId };

  const machineIds = [...new Set(others.map((p) => String(p.assignedMachineId || "")).filter(Boolean))];
  const machines = machineIds.length
    ? await Machine.find({ _id: { $in: machineIds } }).select("machineName").lean()
    : [];
  const machineNameById = new Map(machines.map((m) => [String(m._id), m.machineName || ""]));

  // pool -> Set(stockId) -> owning order info
  const stockIdsByPool = { facestock: new Map(), adhesive: new Map(), release: new Map() };
  for (const p of others) {
    const info = { lotNo: p.lotNo || "", machineName: machineNameById.get(String(p.assignedMachineId || "")) || "" };
    for (const [pool, ids] of Object.entries(p.liveMaterialInUse || {})) {
      if (!stockIdsByPool[pool]) continue;
      for (const sid of ids || []) {
        stockIdsByPool[pool].set(String(sid), info);
        byStockId.set(`${pool}|${String(sid)}`, { ...info, pool });
      }
    }
    for (const s of p.materialSwapLog || []) {
      if (!s?.pool || !stockIdsByPool[s.pool] || !s.stockId) continue;
      stockIdsByPool[s.pool].set(String(s.stockId), info);
      byStockId.set(`${s.pool}|${String(s.stockId)}`, { ...info, pool: s.pool });
    }
  }

  // Translate every in-use stockId back to its rollId so a scanned id (which
  // is a rollId, not a stockId) can be checked directly.
  for (const [pool, map] of Object.entries(stockIdsByPool)) {
    if (!map.size) continue;
    const { Model } = POOL_MODELS[pool];
    const reels = await Model.find({ _id: { $in: [...map.keys()] } }).select("rollId").lean();
    for (const r of reels) {
      const key = normalizeRollId(r.rollId);
      if (key) byRollId.set(key, { ...map.get(String(r._id)), pool });
    }
  }

  return { byStockId, byRollId };
}

// Shows every order currently assigned to a machine (via Assign Production)
// that hasn't been produced yet.
router.get("/machine/:id/queue", requireMachineFloor, async (req, res) => {
  const fallbackUrl =
    req.session?.authUser?.role === "operator" ? "/sachiko/machine/queue" : "/sachiko/form/machine";

  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid machine");
    return res.redirect(fallbackUrl);
  }

  const machine = await Machine.findById(req.params.id).populate("location").lean();
  if (!machine) {
    req.flash("notification", "Machine not found");
    return res.redirect(fallbackUrl);
  }

  const rows = await buildQueueRows({ assignedMachineId: machine._id, producedAt: null });

  res.render("inventory/masters/machineQueue.ejs", {
    title: `${machine.machineName} Queue`,
    CSS: "tableDisp.css",
    JS: false,
    machine,
    rows,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Job Card---------------------------------->

// "Initiate Production" on the machine queue lands here with
// ?pendingId=<PendingProduction _id>, prefilling lot no / product / paper /
// operator / helper from that queue row so the operator only has to fill in
// materials, job setting and the production log by hand.
router.get("/machine/jobcard/form", requireMachineFloor, async (req, res) => {
  const pendingId = req.query.pendingId;
  let machine = null;
  let prefill = null;
  let materialSwapLog = [];

  let eligibleRawStock = { facestock: [], adhesive: [], release: [] };
  if (pendingId && mongoose.isValidObjectId(pendingId)) {
    const pendingDoc = await PendingProduction.findById(pendingId).select("assignedMachineId itemId allottedLayers materialSwapLog").lean();
    materialSwapLog = pendingDoc?.materialSwapLog || [];
    if (pendingDoc?.assignedMachineId) {
      machine = await Machine.findById(pendingDoc.assignedMachineId).lean();
      const rows = await buildQueueRows({ assignedMachineId: pendingDoc.assignedMachineId });
      prefill = rows.find((r) => r._id === String(pendingId)) || null;
      if (pendingDoc.itemId) {
        eligibleRawStock = await getEligibleRawMaterials({
          labelStock: pendingDoc.itemId,
          allottedLayers: pendingDoc.allottedLayers,
        });
      }
    }
  }

  // A pendingId that resolves to nothing -- the order was deleted, sent back
  // to Pending, or the link is simply stale. Without it the form still opens,
  // but every field reads "—" and a save would record a job card belonging to
  // no order and deducting from no reel. Send them back to the queue instead.
  // A form opened with no pendingId at all is left alone: that's the
  // deliberate blank-entry route the POST handler's "new" case covers.
  if (pendingId && !prefill) {
    req.flash("notification", "That production order no longer exists — pick a job from the queue.");
    return res.redirect("/sachiko/machine/queue");
  }

  // Not every raw-material layer has a reel set aside on Assign Production
  // yet -- starting the job card would let the operator scan against
  // material that was never actually reserved, so send them back to the
  // queue instead of opening the form.
  if (prefill && !prefill.canStart) {
    req.flash("notification", "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.");
    return res.redirect(
      prefill.machineId ? `/sachiko/machine/${prefill.machineId}/queue` : "/sachiko/machine/queue"
    );
  }

  const previewJobCardId = await previewId("machineJobCardId", "JC");

  res.render("inventory/masters/jobCardForm.ejs", {
    title: "Production Entry",
    CSS: false,
    JS: false,
    pendingId: pendingId && mongoose.isValidObjectId(pendingId) ? String(pendingId) : "",
    machine,
    prefill,
    previewJobCardId,
    eligibleRawStock,
    materialSwapLog,
    // One-shot token so a double-submit of this page can't save (or deduct) twice.
    submissionToken: randomUUID(),
    notification: req.flash("notification"),
  });
});

// Metres a single row consumed. The two tables measure it differently: a Job
// Setting row is a counter run, so it's the stop reading minus the start
// reading; a Production Log row is one deckle, which carries the metres it
// made outright.
const consumedMeters = (row) => {
  const made = Number(row?.meters);
  if (Number.isFinite(made) && made > 0) return made;
  const from = Number(row?.mtrs1);
  const to = Number(row?.mtrs2);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Draw the running metres recorded on a job card off the facestock reels
// allotted to that job -- both the Job Setting rows (setup wastage) and the
// Production Log rows count. The Roll ID is what the operator scanned off the
// QR label pasted on the reel, so it names exactly one of the job's allotted
// reels (PendingProduction.allottedRollIds -> MaterialStock.rollId) and that
// length comes off its reelMtrs. A reel taken to 0 metres (or below) is
// emptied -- reelMtrs clamped to 0 and quantity set to 0.
//
// Every deduction writes an OUTWARD MaterialStockLog line, the mirror of the
// INWARD one an inward form would write.
export async function consumeAllottedRollMeters({ pendingProductionId, logRows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
  if (!pendingProductionId || !Array.isArray(logRows) || logRows.length === 0) return result;

  const pending = await PendingProduction.findById(pendingProductionId).select("allottedRollIds").lean();
  const rollIds = Array.isArray(pending?.allottedRollIds) ? pending.allottedRollIds : [];

  const reels = rollIds.length
    ? await MaterialStock.find({ _id: { $in: rollIds } })
        .select("rollId material location quantity reelMtrs rate")
        .lean()
    : [];
  const reelByRollId = new Map();
  reels.forEach((reel) => {
    const key = normalizeRollId(reel.rollId);
    if (key && !reelByRollId.has(key)) reelByRollId.set(key, reel);
  });

  // Sum the metres consumed per reel first, so a reel named on more than one
  // row (across job setting and the production log) is written back once.
  const usedByReelId = new Map();
  for (const row of logRows) {
    const used = consumedMeters(row);
    if (used <= 0) continue;
    const key = extractScannedRollId(row.rollId);
    const reel = key ? reelByRollId.get(key) : null;
    if (!reel) {
      if (key) result.unmatched.push(trim(row.rollId));
      continue;
    }
    usedByReelId.set(String(reel._id), (usedByReelId.get(String(reel._id)) || 0) + used);
  }
  if (!usedByReelId.size) return result;

  const reelById = new Map(reels.map((r) => [String(r._id), r]));

  const balanceKey = (reel) => `${String(reel.material)}||${reel.location}`;
  const balances = new Map();
  for (const reelId of usedByReelId.keys()) {
    const reel = reelById.get(reelId);
    const key = balanceKey(reel);
    if (balances.has(key)) continue;
    const bal = await MaterialStock.aggregate([
      { $match: { material: new mongoose.Types.ObjectId(String(reel.material)), location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    balances.set(key, bal[0]?.qty || 0);
  }

  for (const [reelId, used] of usedByReelId) {
    const reel = reelById.get(reelId);
    const remaining = round2((Number(reel.reelMtrs) || 0) - used);
    const emptied = remaining <= 0;

    await MaterialStock.updateOne(
      { _id: reelId },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

    const key = balanceKey(reel);
    const openingStock = balances.get(key) ?? 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;
    balances.set(key, closingStock);

    await MaterialStockLog.create({
      material: reel.material,
      location: reel.location,
      openingStock,
      quantity: rollsOut,
      reelMtrs: round2(used),
      rate: reel.rate,
      rollId: reel.rollId,
      closingStock,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}${round2(used)} mtrs consumed${emptied ? " — reel emptied" : ""}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.deducted += 1;
    result.meters = round2(result.meters + used);
    if (emptied) result.emptied += 1;
  }
  return result;
}

// Deducts the operator-reported usage from each Facestock/Adhesive/Release
// Liner reel/drum recorded in the Material Stock dialog. Directly updates the
// stock balance to the remaining kg entered by the operator.
export async function consumePoolUsage({ pool, rows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, used: 0, rows: [], limited: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const { Model, LogModel } = POOL_MODELS[pool];
  const unitLabel = "kg";
  const requestedByStockId = new Map();
  for (const row of rows) {
    const stockId = trim(row?.stockId);
    if (!stockId) continue;
    const remainingKg = row?.remainingKg !== undefined && row?.remainingKg !== null && Number.isFinite(Number(row.remainingKg))
      ? round2(Number(row.remainingKg))
      : undefined;
    const used = round2(Number(row?.used) || 0);
    requestedByStockId.set(stockId, { remainingKg, used });
  }
  const stockIds = [...requestedByStockId.keys()];
  const reels = stockIds.length
    ? await Model.find({ _id: { $in: stockIds } }).select("rollId type location quantity reelMtrs rate").lean()
    : [];
  const reelById = new Map(reels.map((d) => [String(d._id), d]));

  for (const [stockId, reqData] of requestedByStockId) {
    const reel = reelById.get(stockId);
    if (!reel) continue;

    const available = Math.max(round2(Number(reel.reelMtrs) || 0), 0);
    let newRemaining;
    let used;

    if (reqData.remainingKg !== undefined) {
      newRemaining = Math.max(0, Math.min(reqData.remainingKg, available));
      used = round2(available - newRemaining);
    } else {
      used = Math.min(Math.max(0, reqData.used || 0), available);
      newRemaining = round2(available - used);
    }

    const emptied = newRemaining <= 0;

    const bal = await Model.aggregate([
      { $match: { type: reel.type, location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;

    // Directly update the stock to the remaining kg (new value in stock)
    await Model.updateOne(
      { _id: reel._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: newRemaining } },
    );

    if (used > 0 || emptied) {
      await LogModel.create({
        location: reel.location,
        openingStock,
        quantity: rollsOut,
        closingStock,
        reelMtrs: used,
        rate: reel.rate,
        rollId: reel.rollId,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `${jobCardId ? `${jobCardId}: ` : ""}${used} ${unitLabel} consumed (${newRemaining} ${unitLabel} remaining in stock)${emptied ? " — reel emptied" : ""}`,
        createdBy: createdBy || "SYSTEM",
      });
    }

    result.deducted += 1;
    result.used = round2(result.used + used);
    if (emptied) result.emptied += 1;
    result.rows.push({ stockId: reel._id, rollId: reel.rollId, used, remainingKg: newRemaining });
  }
  return result;
}

// This machine IS the laminator -- every Production Log row is one finished
// Deckle coming off the run right now (the model's own doc comment already
// says as much: "Production Log: one row per deckle produced"), not a
// pre-existing reel merely being drawn down. Raw material for this job was
// already reserved at Assign Production and already deducted elsewhere
// (the older allottedRollIds flow via consumeAllottedRollMeters; the newer
// layerAllotments flow -- Facestock/Adhesive/Release Liner alike -- via
// consumePoolUsage above) -- this only creates the finished-goods side: one
// MaterialStock (Deckle) + one
// INWARD MaterialStockLog per row, at the location the job's own raw
// material sits at. Mirrors produceDeckle's own inward-write half
// (utils/labelStockProduction.js) without repeating its raw-material
// deduction half, since that already happened through a different path here.
//
// A row with no `meters` (Job Setting-style rows, or a Production Log row
// still mid-entry) produces nothing -- there's no length to inward. The
// generated Deckle ID is written back onto the row it came from (by index)
// so the saved job card records which Deckle each row actually became.
export async function produceDecklesFromLog({ pendingDoc, productionLog, jobSetting = [], facestockUsage = [], adhesiveUsage = [], releaseUsage = [], location, jobCardId, createdBy }) {
  const result = { rows: [], rowMeta: [], created: 0, meters: 0, resolvedProductCode: null };
  const labelStockId = pendingDoc?.itemId?._id || pendingDoc?.itemId;
  if (!labelStockId || !location || !Array.isArray(productionLog) || !productionLog.length) return result;

  const baseLabelStock = await SachikoLabelStock.findById(labelStockId).lean();
  if (!baseLabelStock) return result;

  const allFsRollIds = new Set();
  const allAdRollIds = new Set();
  const allRlRollIds = new Set();
  const allFsStockIds = new Set();
  const allAdStockIds = new Set();
  const allRlStockIds = new Set();

  const collectPoolId = (str, rollSet) => {
    const key = extractScannedRollId(str);
    if (key) rollSet.add(key);
  };

  const poolRollSet = { facestock: allFsRollIds, adhesive: allAdRollIds, release: allRlRollIds };
  [...jobSetting, ...productionLog].forEach((r) => {
    collectPoolId(r.fsRollId, allFsRollIds);
    collectPoolId(r.adRollId, allAdRollIds);
    collectPoolId(r.rlRollId, allRlRollIds);
    // Reels a deckle used that aren't its "current" one -- a mid-run swap
    // (see the Materials Mounted strip). Load them into the maps below too.
    (Array.isArray(r.materialsUsed) ? r.materialsUsed : []).forEach((m) => {
      if (poolRollSet[m?.pool]) collectPoolId(m.rollId, poolRollSet[m.pool]);
    });
  });

  (facestockUsage || []).forEach((u) => { if (u.stockId) allFsStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allFsRollIds); });
  (adhesiveUsage || []).forEach((u) => { if (u.stockId) allAdStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allAdRollIds); });
  (releaseUsage || []).forEach((u) => { if (u.stockId) allRlStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allRlRollIds); });

  if (pendingDoc?.allottedLayers) {
    pickStockIds(pendingDoc.allottedLayers.facestock).forEach((id) => allFsStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.facestock2).forEach((id) => allFsStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.adhesive).forEach((id) => allAdStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.adhesive2).forEach((id) => allAdStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.releaseLiner).forEach((id) => allRlStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.releaseLiner2).forEach((id) => allRlStockIds.add(String(id)));
  }

  const fsQuery = [];
  if (allFsStockIds.size) fsQuery.push({ _id: { $in: [...allFsStockIds] } });
  if (allFsRollIds.size) fsQuery.push({ rollId: { $in: [...allFsRollIds] } });
  const fsDocs = fsQuery.length ? await FacestockStock.find({ $or: fsQuery }).lean() : [];
  const fsByRollId = new Map();
  fsDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) fsByRollId.set(k, d);
    fsByRollId.set(String(d._id), d);
  });

  const adQuery = [];
  if (allAdStockIds.size) adQuery.push({ _id: { $in: [...allAdStockIds] } });
  if (allAdRollIds.size) adQuery.push({ rollId: { $in: [...allAdRollIds] } });
  const adDocs = adQuery.length ? await AdhesiveStock.find({ $or: adQuery }).lean() : [];
  const adByRollId = new Map();
  adDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) adByRollId.set(k, d);
    adByRollId.set(String(d._id), d);
  });

  const rlQuery = [];
  if (allRlStockIds.size) rlQuery.push({ _id: { $in: [...allRlStockIds] } });
  if (allRlRollIds.size) rlQuery.push({ rollId: { $in: [...allRlRollIds] } });
  const rlDocs = rlQuery.length ? await ReleaseLinerStock.find({ $or: rlQuery }).lean() : [];
  const rlByRollId = new Map();
  rlDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) rlByRollId.set(k, d);
    rlByRollId.set(String(d._id), d);
  });

  // Track / create all combinations of materials used in this job (same method as Assign Production)
  const pickedLayers = [];
  if (fsDocs.length) pickedLayers.push({ layerKey: "facestock", pool: "facestock", reels: fsDocs });
  if (adDocs.length) pickedLayers.push({ layerKey: "adhesive", pool: "adhesive", reels: adDocs });
  if (rlDocs.length) pickedLayers.push({ layerKey: "releaseLiner", pool: "release", reels: rlDocs });
  if (pickedLayers.length) {
    try {
      await resolveLabelStockCombinations(baseLabelStock, pickedLayers);
    } catch (comboErr) {
      console.error("RESOLVE COMBINATIONS ERROR:", comboErr);
    }
  }

  const poolMap = { facestock: fsByRollId, adhesive: adByRollId, release: rlByRollId };

  let lastFsReel = fsDocs[0] || null;
  let lastAdReel = adDocs[0] || null;
  let lastRlReel = rlDocs[0] || null;

  // Every reel that fed this deckle. Prefers the row's own materialsUsed list
  // (the strip records each reel mounted during the row's run, so a mid-run
  // facestock swap keeps both), and falls back to the single "current" reel
  // per pool when the client didn't send a list.
  const buildSourceReels = (row) => {
    const out = [];
    const seen = new Set();
    const add = (pool, reel, rawRollId) => {
      const doc = reel
        || poolMap[pool]?.get(extractScannedRollId(rawRollId))
        || (rawRollId && poolMap[pool]?.get(String(rawRollId)));
      const rollId = doc?.rollId || trim(rawRollId);
      const key = `${pool}|${normalizeRollId(rollId)}`;
      if (!rollId || seen.has(key)) return;
      seen.add(key);
      out.push({ pool, stockId: doc?._id ? String(doc._id) : undefined, rollId });
    };
    (Array.isArray(row.materialsUsed) ? row.materialsUsed : []).forEach((m) => {
      if (m?.pool && (m.rollId || m.stockId)) add(m.pool, null, m.rollId || m.stockId);
    });
    if (!out.length) {
      add("facestock", lastFsReel);
      add("adhesive", lastAdReel);
      add("release", lastRlReel);
    }
    return out;
  };

  const reelSummary = (reels) => {
    const byPool = { facestock: [], adhesive: [], release: [] };
    reels.forEach((r) => { if (byPool[r.pool]) byPool[r.pool].push(r.rollId); });
    return [
      byPool.facestock.length ? `FS ${byPool.facestock.join(", ")}` : "",
      byPool.adhesive.length ? `AD ${byPool.adhesive.join(", ")}` : "",
      byPool.release.length ? `REL ${byPool.release.join(", ")}` : "",
    ].filter(Boolean).join("; ");
  };

  for (let i = 0; i < productionLog.length; i++) {
    const row = productionLog[i];
    const meters = round2(Number(row.meters) || 0);
    if (meters <= 0) {
      result.rows.push(null);
      result.rowMeta.push(null);
      continue;
    }

    const fsKey = extractScannedRollId(row.fsRollId);
    if (fsKey && fsByRollId.has(fsKey)) lastFsReel = fsByRollId.get(fsKey);

    const adKey = extractScannedRollId(row.adRollId);
    if (adKey && adByRollId.has(adKey)) lastAdReel = adByRollId.get(adKey);

    const rlKey = extractScannedRollId(row.rlRollId);
    if (rlKey && rlByRollId.has(rlKey)) lastRlReel = rlByRollId.get(rlKey);

    const resolvedLayers = [
      lastFsReel ? { layerKey: "facestock", meta: LAYER_META.facestock, reel: lastFsReel } : null,
      lastAdReel ? { layerKey: "adhesive", meta: LAYER_META.adhesive, reel: lastAdReel } : null,
      lastRlReel ? { layerKey: "releaseLiner", meta: LAYER_META.releaseLiner, reel: lastRlReel } : null,
    ].filter(Boolean);

    let actualLabelStock = baseLabelStock;
    if (resolvedLayers.length) {
      try {
        actualLabelStock = await resolveActualLabelStock(baseLabelStock, resolvedLayers);
      } catch (variantErr) {
        console.error("VARIANT RESOLUTION ERROR ON ROW:", variantErr);
        actualLabelStock = baseLabelStock;
      }
    }

    const sourceReels = buildSourceReels(row);
    const rowProductCode = actualLabelStock?.productCode || baseLabelStock.productCode || "";

    // Already inwarded to Semi-Finished Stock the instant its Stop was punched
    // (POST /machine/jobcard/log/produce). Don't re-produce it -- but the
    // variant + reel trace above are still resolved so the saved job card row
    // carries them. Two ways a row can already be produced:
    //   - the client marked it so (alreadyProduced + the system deckleId it
    //     got back), or
    //   - it isn't marked, but a Deckle carrying this row's idempotency token
    //     exists anyway -- the instant call committed it and only its response
    //     was lost. Match on the token and reuse it rather than minting a
    //     second Deckle for the same physical roll.
    let existingDeckleId = row.alreadyProduced && row.deckleId ? row.deckleId : "";
    // Carried alongside existingDeckleId so rowMeta.stockId (see below -- used
    // by the mobile app's Deckle print button) is populated on every replay
    // path, not just a fresh create.
    let existingStockId = null;
    if (!existingDeckleId && row.rowToken) {
      const priorDeckle = await MaterialStock.findOne({ productionRowToken: row.rowToken })
        .select("rollId")
        .lean();
      if (priorDeckle) {
        existingDeckleId = priorDeckle.rollId;
        existingStockId = priorDeckle._id;
      }
    }
    if (existingDeckleId) {
      if (!existingStockId) {
        const doc = await MaterialStock.findOne({ rollId: existingDeckleId }).select("_id").lean();
        existingStockId = doc?._id || null;
      }
      result.rows.push(existingDeckleId);
      result.rowMeta.push({
        productCode: rowProductCode,
        sourceReels,
        stockId: existingStockId ? String(existingStockId) : null,
      });
      if (rowProductCode) result.resolvedProductCode = rowProductCode;
      continue;
    }

    const deckleId = await generateDeckleId(rowProductCode || baseLabelStock.skuCode, pendingDoc.lotNo);

    // The job card records the status of both webs. Preserve the actual
    // selected value(s) on this particular finished reel for its SOFT.prn
    // JOINTS field, while omitting it completely for a clean run.
    const joints = [...new Set([row.face?.joint, row.release?.joint]
      .map((value) => trim(value))
      .filter(Boolean))]
      .join(" / ") || undefined;

    const bal = await MaterialStock.aggregate([
      { $match: { material: actualLabelStock._id, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;

    let createdDeckle;
    try {
      createdDeckle = await MaterialStock.create({
        material: actualLabelStock._id,
        location,
        quantity: 1,
        reelMtrs: meters,
        size: trim(pendingDoc.paperSize),
        joints,
        lotNo: trim(pendingDoc.lotNo),
        rollId: deckleId,
        producedFor: pendingDoc._id,
        sourceReels,
        productionRowToken: row.rowToken || undefined,
        producedVia: "jobcard",
      });
    } catch (createErr) {
      // Lost the race to a concurrent instant-produce of this same row (its
      // Deckle just landed under the shared idempotency token). Reuse it --
      // the generated deckleId above is simply abandoned, same as any other
      // failed create.
      if (createErr?.code === 11000 && row.rowToken) {
        const priorDeckle = await MaterialStock.findOne({ productionRowToken: row.rowToken })
          .select("rollId")
          .lean();
        if (priorDeckle) {
          result.rows.push(priorDeckle.rollId);
          result.rowMeta.push({ productCode: rowProductCode, sourceReels, stockId: String(priorDeckle._id) });
          if (rowProductCode) result.resolvedProductCode = rowProductCode;
          continue;
        }
      }
      throw createErr;
    }

    const traceNote = `as ${rowProductCode || baseLabelStock.productCode}${sourceReels.length ? ` from ${reelSummary(sourceReels)}` : ""}`;
    await MaterialStockLog.create({
      material: actualLabelStock._id,
      location,
      openingStock,
      quantity: 1,
      closingStock: openingStock + 1,
      reelMtrs: meters,
      rollId: deckleId,
      type: "INWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}Deckle produced from Production Log row ${i + 1} — ${traceNote}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.rows.push(deckleId);
    result.rowMeta.push({ productCode: rowProductCode, sourceReels, stockId: String(createdDeckle._id) });
    result.created += 1;
    result.meters = round2(result.meters + meters);
    if (rowProductCode) result.resolvedProductCode = rowProductCode;
  }
  return result;
}

// Where a Deckle produced for this order gets inwarded -- the same location
// its own raw material already sits at (Assign Production's reel pickers are
// scoped to one location per order, so every layer agrees anyway). Facestock
// is checked first since every roll type calls for it; release liner is the
// fallback for the one hypothetical recipe that somehow doesn't (there isn't
// one today, but nothing enforces it). Shared by the final bulk save below
// and the per-row instant-produce endpoint right after it.
export async function resolveDeckleLocation(pendingDoc) {
  if (!pendingDoc?.allottedLayers) return "";
  for (const key of ["facestock", "facestock2", "adhesive", "adhesive2", "releaseLiner", "releaseLiner2"]) {
    const pick = pendingDoc.allottedLayers[key];
    const sids = pickStockIds(pick);
    if (!pick?.pool || !sids.length) continue;
    const { Model } = POOL_MODELS[pick.pool];
    const doc = await Model.findById(sids[0]).select("location").lean();
    if (doc?.location) return doc.location;
  }
  return "";
}

// The primary recipe layer key for each raw-material pool.
const POOL_PRIMARY_LAYER = { facestock: "facestock", adhesive: "adhesive", release: "releaseLiner" };

// Resolve which Label Stock the CURRENTLY MOUNTED combination (the reel just
// scanned for `pool` + the reels already on for the other pools) WOULD
// produce -- its own SKU, or a "-A"/"-B"/... Product Code variant when the
// combination differs from the order's SKU spec on a soft field (vendor,
// size, ...). Read-only: resolveActualLabelStock is called with dryRun, so
// this scan-time check (fires on every scan/blur) never writes a variant
// row -- that happens for real at produce time (produceDecklesFromLog).
//
// Deliberately only resolves once EVERY pool the recipe needs has a reel --
// a half-scanned combination (facestock in, adhesive/release still from the
// SKU spec) isn't a real combination to report. Until the mount is complete
// the caller just shows "pending".
export async function resolveScannedCombinationVariant({ baseLabelStock, pool, reel, mounted }) {
  if (!baseLabelStock) return null;

  const wanted = { facestock: null, adhesive: null, release: null };
  wanted[pool] = reel;

  const codeToPool = { fs: "facestock", ad: "adhesive", rl: "release" };
  for (const [code, otherPool] of Object.entries(codeToPool)) {
    if (otherPool === pool) continue;
    const rid = extractScannedRollId(mounted?.[code]);
    if (!rid) continue;
    wanted[otherPool] = await POOL_MODELS[otherPool].Model.findOne({ rollId: rid }).lean();
  }

  const requiredPools = [...new Set(
    requiredLayersFor(baseLabelStock.rollType).map((k) => LAYER_META[k]?.pool).filter(Boolean),
  )];
  const complete = requiredPools.every((p) => wanted[p]);
  if (!complete) {
    return { pending: true, baseProductCode: baseLabelStock.productCode };
  }

  const resolvedLayers = requiredPools
    .filter((p) => wanted[p])
    .map((p) => ({ layerKey: POOL_PRIMARY_LAYER[p], meta: LAYER_META[POOL_PRIMARY_LAYER[p]], reel: wanted[p] }));

  // dryRun: this is a scan-time validation check that fires on every scan and
  // blur -- it must not write a variant Product Code row. The real row is
  // minted later, at produce time (produceDecklesFromLog).
  const actual = await resolveActualLabelStock(baseLabelStock, resolvedLayers, { dryRun: true });
  const isVariant = Boolean(actual.__dryRun) || String(actual._id) !== String(baseLabelStock._id);
  return {
    productCode: actual.productCode || baseLabelStock.productCode,
    skuCode: actual.skuCode || baseLabelStock.skuCode,
    baseProductCode: baseLabelStock.productCode,
    isVariant,
  };
}

// Validates one raw-material reel the operator has scanned/typed into the
// Materials Mounted strip, BEFORE it's committed to anything. The shop floor
// is free to run whatever reel physically matches the recipe -- the office
// allotment is only a name here -- but:
//   - the reel has to match this order's recipe on the must-match fields
//     (getEligibleRawMaterials' validStockIds).
//   - the reel must not already be WIP on another still-open job -- one
//     physical reel can't feed two machines (HARD stop / blocking alert).
//   - the resulting facestock+adhesive+release combination is resolved to the
//     Product Code it would produce (read-only -- the "-A"/"-B" variant row is
//     minted for real only at produce time, not by this check).
router.post("/machine/jobcard/material/check", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId, mounted } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) {
      return res.status(400).json({ ok: false, code: "bad-request" });
    }
    if (!POOL_MODELS[pool]) {
      return res.status(400).json({ ok: false, code: "bad-request" });
    }
    if (!String(rollId ?? "").trim()) return res.json({ ok: false, code: "unknown" });

    const pendingDoc = await PendingProduction.findById(pendingId)
      .select("itemId allottedLayers")
      .lean();
    if (!pendingDoc) return res.status(404).json({ ok: false, code: "no-order" });

    // Resolved against stock itself rather than parsed down to one id first:
    // a label's QR ends with the Roll ID glued straight onto the box in front
    // of it, so only stock can say where the id starts. See findScannedReel in
    // utils/rollId.js.
    const reel = await findScannedReel(POOL_MODELS[pool].Model, rollId);
    if (!reel) return res.json({ ok: false, code: "unknown" });

    // A reel inwarded without its purchase invoice is not fit to run: the
    // invoice is what ties the physical reel to what was actually bought, and
    // it is the LOT NO printed on its own label (see utils/facestockRollLabel.js
    // and its siblings), so a blank one also means the sticker on the reel
    // carries no lot. Refused before the recipe and WIP checks below -- those
    // describe a reel that is fine but wrong for this order or busy right now,
    // whereas this one must not be consumed on any order until the office
    // fills the invoice in. invoiceNo is an optional String on all three raw
    // pools, so it can be absent, null or "".
    if (!String(reel.invoiceNo || "").trim()) {
      return res.json({ ok: false, code: "no-invoice", rollId: reel.rollId });
    }

    const eligible = await getEligibleRawMaterials({
      labelStock: pendingDoc.itemId,
      allottedLayers: pendingDoc.allottedLayers,
    });
    const matchesRecipe = eligible.validStockIds?.[pool]?.has(String(reel._id));

    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(reel._id)}`);
    if (wip) {
      return res.json({
        ok: false,
        code: "wip",
        rollId: reel.rollId,
        lotNo: wip.lotNo,
        machineName: wip.machineName,
      });
    }

    if (!matchesRecipe) {
      return res.json({ ok: false, code: "mismatch", rollId: reel.rollId });
    }

    const allotted = new Set(
      Object.values(pendingDoc.allottedLayers || {})
        .filter((pick) => pick?.pool === pool)
        .flatMap((pick) => pickStockIds(pick).map(String)),
    );

    let variant = null;
    try {
      const baseLabelStock = await SachikoLabelStock.findById(pendingDoc.itemId).lean();
      variant = await resolveScannedCombinationVariant({ baseLabelStock, pool, reel, mounted });
    } catch (variantErr) {
      console.error("SCAN VARIANT RESOLUTION ERROR:", variantErr);
    }

    res.json({
      ok: true,
      reel: {
        _id: String(reel._id),
        rollId: reel.rollId,
        reelMtrs: Number(reel.reelMtrs) || 0,
        location: reel.location || "",
        allotted: allotted.has(String(reel._id)),
      },
      variant,
    });
  } catch (err) {
    console.error("JOB CARD MATERIAL CHECK ERROR:", err);
    res.status(500).json({ ok: false, code: "error" });
  }
});

// Fires the moment a Job Setting/Production Log row's Start is punched (see
// the .js-start-btn/.log-start-btn handlers in jobCardForm.ejs), for
// whichever of that row's Jumbo FS id/Drum id/Jumbo REL id are already
// filled in -- long before Save Production Entry exists to record real
// consumption. Purely a live "this reel is now actually being drawn on"
// hint (PendingProduction.liveMaterialInUse, see its own schema comment),
// read by /sachiko/facestockstock (and Adhesive/Release Liner Stock) to
// show which specific reel a job is running against, distinct from
// whichever reel was merely allotted on paper at Assign Production. A
// scanned id that isn't a real reel, or a pool this order has no live use
// for yet, is simply ignored -- this never blocks the operator from
// continuing to fill in the card.
router.post("/machine/jobcard/mark-in-use", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) return res.status(400).json({ success: false });
    const poolInfo = POOL_MODELS[pool];
    if (!poolInfo) return res.status(400).json({ success: false });

    if (!String(rollId ?? "").trim()) return res.status(400).json({ success: false });

    // Resolved against stock itself rather than parsed down to one id first:
    // a label's QR ends with the Roll ID glued straight onto the box in front
    // of it, so only stock can say where the id starts. See findScannedReel in
    // utils/rollId.js.
    const reel = await findScannedReel(poolInfo.Model, rollId, "_id rollId");
    if (!reel) return res.status(404).json({ success: false });

    // Hard stop: this reel is already running on another still-open job. Don't
    // mark it in use here -- the UI shows a blocking alert and the operator
    // must scan a different one.
    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(reel._id)}`);
    if (wip) {
      return res.status(409).json({
        success: false,
        code: "wip",
        rollId: reel.rollId,
        lotNo: wip.lotNo,
        machineName: wip.machineName,
      });
    }

    await PendingProduction.updateOne(
      { _id: pendingId },
      { $addToSet: { [`liveMaterialInUse.${pool}`]: reel._id } },
    );
    res.json({ success: true });
  } catch (err) {
    console.error("JOB CARD MARK-IN-USE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// Fires the moment a Production Log row's Stop is punched (with its Meters
// already filled in) -- see the .log-stop-btn handler in jobCardForm.ejs --
// rather than waiting for the whole Job Card to be saved. On a job that runs
// a full shift, that's the difference between a Deckle showing up on Semi
// Finished Stock right away and it not existing anywhere until the operator
// eventually hits "Save Production Entry" hours later. Reuses
// produceDecklesFromLog for a single row; the job card doesn't exist yet at
// this point (it's only created on final save), so its remarks simply omit a
// job card id prefix. The final save then skips re-producing any row this
// endpoint already inwarded -- see productionLog's `alreadyProduced` in
// POST /machine/jobcard/form below -- so it's recorded once, not twice.
//
// Idempotent on the row's `rowToken` (MaterialStock.productionRowToken): a
// retried call whose first response was lost, and the final save if the row
// never came back marked produced, both match the existing Deckle on that
// token and reuse it instead of making a duplicate.
router.post("/machine/jobcard/log/produce", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    if (!mongoose.isValidObjectId(b.pendingId)) {
      return res.status(400).json({ success: false, message: "Missing or invalid production order." });
    }
    const meters = numOrUndef(b.meters);
    if (!meters || meters <= 0) {
      return res.status(400).json({ success: false, message: "Enter the produced metres first." });
    }

    // Idempotent replay: a Deckle carrying this row's token already exists,
    // so the first attempt committed and only its response was lost. Hand
    // back the same Deckle instead of inwarding a second one.
    const rowToken = trim(b.rowToken) || undefined;
    if (rowToken) {
      const priorDeckle = await MaterialStock.findOne({ productionRowToken: rowToken })
        .select("rollId reelMtrs location material sourceReels")
        .populate({ path: "material", select: "productCode" })
        .lean();
      if (priorDeckle) {
        return res.json({
          success: true,
          deckleId: priorDeckle.rollId,
          meters: Number(priorDeckle.reelMtrs) || 0,
          location: priorDeckle.location || "",
          productCode: priorDeckle.material?.productCode || "",
          sourceReels: priorDeckle.sourceReels || [],
          replayed: true,
        });
      }
    }

    const pendingDoc = await PendingProduction.findById(b.pendingId)
      .select("allottedLayers itemId paperSize lotNo")
      .lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }

    const deckleLocation = await resolveDeckleLocation(pendingDoc);
    if (!deckleLocation) {
      return res.status(400).json({ success: false, message: "Couldn't resolve a stock location for this order." });
    }

    const fs = trim(b.fsRollId);
    const ad = trim(b.adRollId);
    const rl = trim(b.rlRollId);
    let materialsUsed = [];
    try {
      const arr = JSON.parse(b.materialsUsed || "[]");
      if (Array.isArray(arr)) {
        materialsUsed = arr
          .filter((m) => m && m.pool && (m.rollId || m.stockId))
          .map((m) => ({ pool: trim(m.pool), rollId: trim(m.rollId), stockId: mongoose.isValidObjectId(m.stockId) ? m.stockId : undefined }));
      }
    } catch { materialsUsed = []; }
    const row = {
      rollId: fs || [fs, ad, rl].filter(Boolean).join(", "),
      fsRollId: fs,
      adRollId: ad,
      rlRollId: rl,
      materialsUsed,
      deckleId: "",
      rowToken,
      startMtrs: numOrUndef(b.startMtrs),
      stopMtrs: numOrUndef(b.stopMtrs),
      meters,
      face: { joint: trim(b.faceJoint), mtr: numOrUndef(b.faceMtr) },
      release: { joint: trim(b.releaseJoint), mtr: numOrUndef(b.releaseMtr) },
      time: { startTime: trim(b.startTime), endTime: trim(b.endTime) },
    };

    const production = await produceDecklesFromLog({
      pendingDoc,
      productionLog: [row],
      location: deckleLocation,
      createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
    });

    const deckleId = production.rows[0];
    if (!deckleId) {
      return res.status(400).json({ success: false, message: "Couldn't produce a Deckle for this row." });
    }

    // Firm the reel reservation: every reel this Deckle actually consumed is
    // now locked to this order, whether or not the scan-time mark-in-use call
    // landed. Released only when the order finishes (final Save) or is sent
    // back to Pending. Best-effort -- a hiccup here never fails the produce.
    try {
      const addToSet = {};
      for (const sr of production.rowMeta?.[0]?.sourceReels || []) {
        if (!sr?.pool || !POOL_MODELS[sr.pool] || !mongoose.isValidObjectId(sr.stockId)) continue;
        const key = `liveMaterialInUse.${sr.pool}`;
        // ObjectId, to match POST /machine/jobcard/mark-in-use -- a Mixed
        // array would otherwise hold the same reel as both a string and an
        // ObjectId and $addToSet wouldn't dedupe them.
        (addToSet[key] ||= { $each: [] }).$each.push(new mongoose.Types.ObjectId(String(sr.stockId)));
      }
      if (Object.keys(addToSet).length) {
        await PendingProduction.updateOne({ _id: b.pendingId }, { $addToSet: addToSet });
      }
    } catch (lockErr) {
      console.error("JOB CARD INSTANT DECKLE LOCK ERROR:", lockErr);
    }

    res.json({
      success: true,
      deckleId,
      meters: production.meters,
      location: deckleLocation,
      productCode: production.rowMeta?.[0]?.productCode || "",
      sourceReels: production.rowMeta?.[0]?.sourceReels || [],
    });
  } catch (err) {
    console.error("JOB CARD INSTANT DECKLE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to move this Deckle to Semi Finished Stock." });
  }
});

// Fires when the operator clicks "Change" on a mounted material (a reel ran
// out, or the wrong one was scanned) -- reconciles the OUTGOING reel before
// the next one goes on. The operator enters how many kg are physically left
// on it; stock is updated to exactly that (consumed = current - remaining,
// reel emptied at 0), and the swap is recorded on the order so (a) the
// end-of-job Material Used dialog skips this reel and (b) the shop floor can
// see a short "what was used on this job" history. No allocation here -- any
// recipe-matching in-stock reel is fair game.
router.post("/machine/jobcard/material/set-remaining", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, stockId, remainingKg } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) {
      return res.status(400).json({ success: false, message: "Missing production order." });
    }
    if (!POOL_MODELS[pool]) {
      return res.status(400).json({ success: false, message: "Unknown material pool." });
    }
    if (!mongoose.isValidObjectId(stockId)) {
      return res.status(400).json({ success: false, message: "Missing stock reference." });
    }
    const remaining = Number(remainingKg);
    if (!Number.isFinite(remaining) || remaining < 0) {
      return res.status(400).json({ success: false, message: "Enter a valid non-negative kg amount." });
    }
    // Mandatory -- why this reel is coming off the job mid-run. Checked here
    // too, not just client-side, so the swap is never recorded without one.
    const reason = trim(req.body?.reason).slice(0, 300);
    if (reason.length < 3) {
      return res.status(400).json({ success: false, message: "Give a reason for taking this reel off the job." });
    }

    const pendingDoc = await PendingProduction.findById(pendingId).select("allottedLayers itemId").lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }

    // Any reel that matches this order's recipe (allotted or not) can be
    // resolved this way -- getEligibleRawMaterials' validStockIds is that set.
    const eligible = await getEligibleRawMaterials({ labelStock: pendingDoc.itemId, allottedLayers: pendingDoc.allottedLayers });
    if (!eligible.validStockIds?.[pool]?.has(String(stockId))) {
      return res.status(400).json({ success: false, message: "That reel doesn't match this order's recipe." });
    }

    // A reel running on another still-open job can't be drawn down here.
    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(stockId)}`);
    if (wip) {
      return res.status(409).json({ success: false, code: "wip", lotNo: wip.lotNo, machineName: wip.machineName });
    }

    const createdBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const result = await consumePoolUsage({
      pool,
      rows: [{ stockId, remainingKg: remaining }],
      jobCardId: "",
      createdBy,
    });
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, message: "Couldn't find that reel in stock." });
    }

    const swapEntry = {
      pool,
      stockId: row.stockId,
      rollId: row.rollId,
      usedKg: row.used,
      remainingKg: row.remainingKg,
      emptied: row.remainingKg <= 0,
      reason,
      swappedAt: new Date(),
      swappedBy: createdBy,
    };
    await PendingProduction.updateOne({ _id: pendingId }, { $push: { materialSwapLog: swapEntry } });

    res.json({ success: true, swap: swapEntry });
  } catch (err) {
    console.error("JOB CARD MATERIAL SET-REMAINING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update stock." });
  }
});

// Extracted from POST /machine/jobcard/form so the JSON operator API's
// POST /jobcard (routes/api/operatorApi.js) can reuse this exact
// save/consume/produce pipeline instead of re-deriving it. Deliberately
// takes no req/res -- every early exit (idempotent resubmit, allotment
// gate, a reel already WIP elsewhere) and the final outcome are reported
// back as a status object; callers decide what to do with it (the EJS
// route below turns it into a flash+redirect, the bearer route turns it
// into a JSON response).
export async function saveMachineJobCard({ body, actorName }) {
  const b = body;
  const createdBy = actorName || "SYSTEM";
  try {
    // Idempotency: a resubmit of the same loaded page carries the same
    // token. If one already saved, don't create a second entry or deduct
    // stock again -- just report it as already-saved.
    const submissionToken = trim(b.submissionToken);
    if (submissionToken) {
      const already = await MachineJobCard.findOne({ submissionToken }).select("_id").lean();
      if (already) {
        return { status: "duplicate", pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new" };
      }
    }

    // Mirror the GET guard -- a direct POST (bypassing the form) still can't
    // start a job with no reels actually set aside for it. Kept in scope past
    // this block (not just re-checked here) -- the Adhesive Used dialog's
    // rows get validated against this same order's own allottedLayers below,
    // rather than trusting whatever stockIds the client posted.
    let pendingDoc = null;
    if (mongoose.isValidObjectId(b.pendingId)) {
      pendingDoc = await PendingProduction.findById(b.pendingId)
        .select("allottedRollIds allottedLayers itemId paperSize lotNo materialSwapLog noOfRolls quantity isDeckleBatch producedRolls")
        .populate({ path: "itemId", select: "rollType" })
        .lean();
      if (!pendingDoc || !hasStartableAllotment({
        rollType: pendingDoc.itemId?.rollType,
        allottedLayers: pendingDoc.allottedLayers,
        allottedRollIds: pendingDoc.allottedRollIds,
      })) {
        return {
          status: "gate-failed",
          message: "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.",
          machineId: b.machineId,
        };
      }
    }

    // Where each new Deckle this job produces gets inwarded -- see
    // resolveDeckleLocation above.
    const deckleLocation = await resolveDeckleLocation(pendingDoc);

    // Material Used dialog rows -- one per reel this order actually had
    // reserved, per pool (facestockStockId[]/facestockMtrsUsed[],
    // adhesiveStockId[]/adhesiveKgUsed[], releaseStockId[]/
    // releaseMtrsUsed[], each its own parallel-array pair, same convention as
    // Job Setting/Production Log above). Only a stockId that's genuinely one
    // of this order's own allottedLayers picks for that pool is kept -- the
    // dialog only ever offers those, but the form is still a POST body, not
    // a trusted source.
    let eligiblePostStock = { facestock: [], adhesive: [], release: [], validStockIds: { facestock: new Set(), adhesive: new Set(), release: new Set() } };
    if (pendingDoc?.itemId) {
      eligiblePostStock = await getEligibleRawMaterials({
        labelStock: pendingDoc.itemId,
        allottedLayers: pendingDoc.allottedLayers,
      });
    }

    const validStockIdsForPool = (pool, keys) => {
      const allotted = new Set(
        keys
          .map((key) => pendingDoc?.allottedLayers?.[key])
          .filter((pick) => pick?.pool === pool)
          .flatMap((pick) => pickStockIds(pick)),
      );
      const eligible = eligiblePostStock.validStockIds?.[pool] || new Set();
      return new Set([...allotted, ...eligible]);
    };

    // A reel already resolved live via the Materials in Use "Add" flow
    // (POST /machine/jobcard/material/set-remaining) was already deducted at
    // that moment -- the client's own Material Used dialog is told not to
    // ask about it again, but this is the belt-and-suspenders backstop
    // against double-deducting the same reel if it slips through anyway.
    const alreadyResolvedStockIds = new Set((pendingDoc?.materialSwapLog || []).map((s) => String(s.stockId)));

    const validFacestockStockIds = validStockIdsForPool("facestock", ["facestock", "facestock2"]);
    const fsStockId = toArray(b.facestockStockId);
    const fsMtrsUsed = toArray(b.facestockMtrsUsed);
    const fsRemainingKg = toArray(b.facestockRemainingKg);
    const facestockUsage = consolidateUsageRows(
      fsStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          mtrsUsed: numOrUndef(fsMtrsUsed[i]),
          remainingKg: numOrUndef(fsRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validFacestockStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "mtrsUsed",
    );

    const validAdhesiveStockIds = validStockIdsForPool("adhesive", ["adhesive", "adhesive2"]);
    const adKgStockId = toArray(b.adhesiveStockId);
    const adKgUsed = toArray(b.adhesiveKgUsed);
    const adRemainingKg = toArray(b.adhesiveRemainingKg);
    const adhesiveUsage = consolidateUsageRows(
      adKgStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          kgUsed: numOrUndef(adKgUsed[i]),
          remainingKg: numOrUndef(adRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validAdhesiveStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "kgUsed",
    );

    const validReleaseStockIds = validStockIdsForPool("release", ["releaseLiner", "releaseLiner2"]);
    const rlStockId = toArray(b.releaseStockId);
    const rlMtrsUsed = toArray(b.releaseMtrsUsed);
    const rlRemainingKg = toArray(b.releaseRemainingKg);
    const releaseUsage = consolidateUsageRows(
      rlStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          mtrsUsed: numOrUndef(rlMtrsUsed[i]),
          remainingKg: numOrUndef(rlRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validReleaseStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "mtrsUsed",
    );

    const jobCardId = await generateId("machineJobCardId", "JC");

    // Job Setting rows
    const jsFsRollId = toArray(b.jsFsRollId);
    const jsAdRollId = toArray(b.jsAdRollId);
    const jsRlRollId = toArray(b.jsRlRollId);
    const jsRollId = toArray(b.jsRollId);
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => {
        const fs = trim(jsFsRollId[i]);
        const ad = trim(jsAdRollId[i]);
        const rl = trim(jsRlRollId[i]);
        const legacyRoll = trim(jsRollId[i]);
        const mainRoll = fs || legacyRoll || [fs, ad, rl].filter(Boolean).join(", ");
        return {
          rollId: mainRoll,
          fsRollId: fs,
          adRollId: ad,
          rlRollId: rl,
          mtrs1: numOrUndef(jsMtrs1[i]),
          startTime: trim(jsStart[i]),
          mtrs2: numOrUndef(jsMtrs2[i]),
          stopTime: trim(jsStop[i]),
        };
      })
      .filter((row) => row.rollId || row.fsRollId || row.adRollId || row.rlRollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows -- one per deckle produced, so alongside Job
    // Setting's start/stop counter pair these also carry the deckle's own
    // produced metres, plus the joint/wrinkle noted on each web.
    const fsRollId = toArray(b.fsRollId);
    const adRollId = toArray(b.adRollId);
    const rlRollId = toArray(b.rlRollId);
    const rollId = toArray(b.rollId);
    const deckleId = toArray(b.deckleId);
    // Set by the instant-produce call the moment this row's Stop was punched
    // (see the .log-stop-btn handler in jobCardForm.ejs and POST
    // /machine/jobcard/log/produce above) -- a row carrying both this and its
    // system-issued deckleId already has its Deckle inwarded to Semi Finished
    // Stock, so produceDecklesFromLog below must not do it again.
    const logInstantProduced = toArray(b.logInstantProduced);
    // Per-row idempotency token (see MaterialStock.productionRowToken) -- lets
    // produceDecklesFromLog below reuse a Deckle the instant-produce call
    // already inwarded even when this row didn't come back marked
    // `alreadyProduced` (its response was lost).
    const logRowToken = toArray(b.logRowToken);
    const logMaterialsUsed = toArray(b.logMaterialsUsed);
    const parseMaterialsUsed = (raw) => {
      try {
        const arr = JSON.parse(raw || "[]");
        return Array.isArray(arr)
          ? arr
              .filter((m) => m && m.pool && (m.rollId || m.stockId))
              .map((m) => ({
                pool: trim(m.pool),
                rollId: trim(m.rollId),
                stockId: mongoose.isValidObjectId(m.stockId) ? m.stockId : undefined,
              }))
          : [];
      } catch { return []; }
    };
    const logStart = toArray(b.logStart);
    const logStartMtrs = toArray(b.logStartMtrs);
    const logEnd = toArray(b.logEnd);
    const logStopMtrs = toArray(b.logStopMtrs);
    const logMeters = toArray(b.logMeters);
    const faceJoint = toArray(b.faceJoint);
    const faceMtr = toArray(b.faceMtr);
    const releaseJoint = toArray(b.releaseJoint);
    const releaseMtr = toArray(b.releaseMtr);
    const productionLog = logMeters
      .map((_, i) => {
        const fs = trim(fsRollId[i]);
        const ad = trim(adRollId[i]);
        const rl = trim(rlRollId[i]);
        const legacyRoll = trim(rollId[i]);
        const mainRoll = fs || legacyRoll || [fs, ad, rl].filter(Boolean).join(", ");
        const rowDeckleId = trim(deckleId[i]);
        return {
          rollId: mainRoll,
          fsRollId: fs,
          adRollId: ad,
          rlRollId: rl,
          deckleId: rowDeckleId,
          rowToken: trim(logRowToken[i]) || undefined,
          materialsUsed: parseMaterialsUsed(logMaterialsUsed[i]),
          alreadyProduced: trim(logInstantProduced[i]) === "1" && Boolean(rowDeckleId),
          startMtrs: numOrUndef(logStartMtrs[i]),
          stopMtrs: numOrUndef(logStopMtrs[i]),
          meters: numOrUndef(logMeters[i]),
          face: { joint: trim(faceJoint[i]), mtr: numOrUndef(faceMtr[i]) },
          release: { joint: trim(releaseJoint[i]), mtr: numOrUndef(releaseMtr[i]) },
          time: { startTime: trim(logStart[i]), endTime: trim(logEnd[i]) },
        };
      })
      .filter(
        (row) =>
          row.rollId ||
          row.fsRollId ||
          row.adRollId ||
          row.rlRollId ||
          row.deckleId ||
          row.startMtrs != null ||
          row.stopMtrs != null ||
          row.meters != null ||
          row.face.mtr != null ||
          row.release.mtr != null ||
          row.time.startTime ||
          row.time.endTime,
      );

    // Hard stop, server-side backstop for the scan-time alert: no reel that is
    // already WIP on another still-open job may be recorded here. Checks every
    // scanned roll id across Job Setting / Production Log, plus every stockId
    // the Material Used dialog posted.
    if (mongoose.isValidObjectId(b.pendingId)) {
      const { byRollId, byStockId } = await reelsInUseElsewhere(b.pendingId);
      if (byRollId.size || byStockId.size) {
        const scannedByPool = { facestock: [], adhesive: [], release: [] };
        for (const r of [...jobSetting, ...productionLog]) {
          if (r.fsRollId) scannedByPool.facestock.push(extractScannedRollId(r.fsRollId));
          if (r.adRollId) scannedByPool.adhesive.push(extractScannedRollId(r.adRollId));
          if (r.rlRollId) scannedByPool.release.push(extractScannedRollId(r.rlRollId));
        }
        let clash = null;
        for (const [, rid] of Object.entries(scannedByPool).flatMap(([p, ids]) => ids.map((id) => [p, id]))) {
          const hit = rid && byRollId.get(rid);
          if (hit) { clash = { rollId: rid, ...hit }; break; }
        }
        if (!clash) {
          for (const u of [...facestockUsage, ...adhesiveUsage, ...releaseUsage]) {
            const poolKey = ["facestock", "adhesive", "release"].find((p) => byStockId.has(`${p}|${String(u.stockId)}`));
            if (poolKey) { clash = { rollId: u.rollId || "", ...byStockId.get(`${poolKey}|${String(u.stockId)}`) }; break; }
          }
        }
        if (clash) {
          return {
            status: "wip-clash",
            message: `Reel ${clash.rollId || ""} is already running on job ${clash.lotNo || "(another order)"}${clash.machineName ? ` at ${clash.machineName}` : ""} — it can't be used here.`,
            machineId: b.machineId,
          };
        }
      }
    }

    await MachineJobCard.create({
      jobCardId,
      submissionToken: submissionToken || undefined,
      date: b.date ? new Date(b.date) : new Date(),
      pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : undefined,
      machineId: mongoose.isValidObjectId(b.machineId) ? b.machineId : undefined,
      machineName: trim(b.machineNo),
      lotNo: trim(b.lotNo),
      productCode: trim(b.productCode),
      paperSize: trim(b.paperSize),
      rolls: trim(b.rolls),
      quantity: numOrUndef(b.quantity),
      operatorName: trim(b.operatorName),
      helperName: trim(b.helperName),
      faceStock: {
        rollDrumNo: trim(b.fsRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.fsRollId).filter(Boolean))].join(", "),
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
      },
      adhesive: {
        rollDrumNo: trim(b.adRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.adRollId).filter(Boolean))].join(", "),
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
      },
      releaseLiner: {
        rollDrumNo: trim(b.rlRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.rlRollId).filter(Boolean))].join(", "),
        code: trim(b.rlCode),
        gsmMic: trim(b.rlGsmMic),
        size: trim(b.rlSize),
      },
      jobSetting,
      productionLog,
      facestockUsage,
      adhesiveUsage,
      releaseUsage,
      totalMeter: trim(b.totalMeter),
      sqMtr: trim(b.sqMtr),
    });

    // Deduct the production log's running metres from the reels this job was
    // allotted. Isolated from the create above: the job card is already
    // saved, so a hiccup here must not read back as a failed save.
    let consumption = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
    try {
      consumption = await consumeAllottedRollMeters({
        pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : null,
        logRows: [...jobSetting, ...productionLog],
        jobCardId,
        createdBy,
      });
    } catch (stockErr) {
      console.error("JOB CARD STOCK DEDUCTION ERROR:", stockErr);
    }

    // Deduct the mtrs/kg the operator reported in the "Material Used" dialog,
    // per pool. Same isolation as above -- the job card and its meter
    // deduction are already committed, so none of these three can turn a
    // successful save into an apparent failure.
    let facestockConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      facestockConsumption = await consumePoolUsage({
        pool: "facestock",
        rows: facestockUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      // Fills in the rollId snapshot the create above couldn't (the reel
      // docs are only read inside consumePoolUsage itself) -- purely
      // cosmetic for the saved card, the deduction already happened above
      // regardless of whether this write succeeds.
      if (facestockConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { facestockUsage: facestockConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (fsErr) {
      console.error("JOB CARD FACESTOCK DEDUCTION ERROR:", fsErr);
    }

    let adhesiveConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      adhesiveConsumption = await consumePoolUsage({
        pool: "adhesive",
        rows: adhesiveUsage.map((r) => ({ stockId: r.stockId, used: r.kgUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      if (adhesiveConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { adhesiveUsage: adhesiveConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, kgUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (adErr) {
      console.error("JOB CARD ADHESIVE DEDUCTION ERROR:", adErr);
    }

    let releaseConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      releaseConsumption = await consumePoolUsage({
        pool: "release",
        rows: releaseUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      if (releaseConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { releaseUsage: releaseConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (rlErr) {
      console.error("JOB CARD RELEASE LINER DEDUCTION ERROR:", rlErr);
    }

    // Lamination: one new Deckle per Production Log row that actually made
    // metres (produceDecklesFromLog above), inwarded to Semi-Finished Stock.
    // Same isolation as the deductions above -- the job card is already
    // saved, so a hiccup here can't turn a successful save into an apparent
    // failure. The generated ids replace whatever the operator typed into
    // each row's Deckle ID box (see productionLog's own `deckleId` above) --
    // system-issued now, the same way jobCardId itself is.
    let deckleProduction = { rows: [], created: 0, meters: 0 };
    try {
      deckleProduction = await produceDecklesFromLog({
        pendingDoc,
        productionLog,
        jobSetting,
        facestockUsage,
        adhesiveUsage,
        releaseUsage,
        location: deckleLocation,
        jobCardId,
        createdBy,
      });
      const updateSet = productionLog.reduce((set, _row, i) => {
        if (deckleProduction.rows[i]) set[`productionLog.${i}.deckleId`] = deckleProduction.rows[i];
        const meta = deckleProduction.rowMeta?.[i];
        if (meta) {
          if (meta.productCode) set[`productionLog.${i}.productCode`] = meta.productCode;
          if (meta.sourceReels?.length) set[`productionLog.${i}.materialsUsed`] = meta.sourceReels;
        }
        return set;
      }, {});
      if (deckleProduction.resolvedProductCode) {
        updateSet.productCode = deckleProduction.resolvedProductCode;
      }
      if (Object.keys(updateSet).length) {
        await MachineJobCard.updateOne({ jobCardId }, { $set: updateSet });
      }
    } catch (deckleErr) {
      console.error("JOB CARD DECKLE PRODUCTION ERROR:", deckleErr);
    }

    // Accumulate the rolls this Job Card produced onto the order (one per
    // Production Log row that recorded metres -- each row is one deckle),
    // and drop the live in-use hint (liveMaterialInUse) -- the real
    // consumption just saved above (facestockUsage etc.) is now the
    // permanent record, so the Start-punch hint that stood in for it has
    // nothing left to add.
    //
    // Only stamp producedAt -- which takes the order off every machine /
    // operator queue -- once the running total of deckles laminated reaches
    // this job's DECKLE target: a plain order's Qty, or a deckle batch's
    // planner-entered Deckle Qty (stored as noOfRolls). Deliberately NOT a
    // plain order's own noOfRolls -- that's the sales order's finished-roll
    // count for the downstream slitting step, always >= the deckle count.
    // Producing fewer than the target (the operator switched to another job
    // mid-order) leaves producedAt unset, so the order stays on the queue
    // showing its balance still to run. An order with no target recorded
    // closes on the first save, as before.
    let productionProgress = null;
    if (mongoose.isValidObjectId(b.pendingId)) {
      try {
        const rollsThisSession = productionLog.filter((r) => Number(r.meters) > 0).length;
        const priorProduced = Number(pendingDoc?.producedRolls) || 0;
        const totalProduced = priorProduced + rollsThisSession;
        const requiredRolls = Number(
          pendingDoc?.isDeckleBatch ? pendingDoc?.noOfRolls : pendingDoc?.quantity,
        );
        const hasTarget = Number.isFinite(requiredRolls) && requiredRolls > 0;
        const complete = !hasTarget || totalProduced >= requiredRolls;
        const update = {
          $set: { producedRolls: totalProduced },
          $unset: { liveMaterialInUse: "" },
        };
        if (complete) update.$set.producedAt = new Date();
        await PendingProduction.updateOne({ _id: b.pendingId }, update);
        productionProgress = { totalProduced, requiredRolls, hasTarget, complete };
      } catch (prodErr) {
        console.error("JOB CARD MARK-PRODUCED ERROR:", prodErr);
      }
    }

    let message = "Production entry saved successfully!";
    if (productionProgress && productionProgress.hasTarget && !productionProgress.complete) {
      const remaining = Math.max(productionProgress.requiredRolls - productionProgress.totalProduced, 0);
      message +=
        ` Job switch: ${productionProgress.totalProduced} of ${productionProgress.requiredRolls} deckle` +
        `${productionProgress.requiredRolls === 1 ? "" : "s"} produced — ${remaining} still pending,` +
        ` order kept on the queue.`;
    }
    if (consumption.deducted) {
      message +=
        ` Stock: ${consumption.meters} mtrs off ${consumption.deducted} reel${consumption.deducted === 1 ? "" : "s"}` +
        `${consumption.emptied ? ` (${consumption.emptied} emptied)` : ""}.`;
    }
    if (consumption.unmatched.length) {
      const uniq = [...new Set(consumption.unmatched)];
      message += ` Note: stock not deducted for roll${uniq.length === 1 ? "" : "s"} ${uniq.join(", ")} (not among this job's allotted reels).`;
    }
    if (facestockConsumption.deducted) {
      message +=
        ` Facestock: ${facestockConsumption.used} kg off ${facestockConsumption.deducted} reel${facestockConsumption.deducted === 1 ? "" : "s"}` +
        `${facestockConsumption.emptied ? ` (${facestockConsumption.emptied} emptied)` : ""}.`;
    }
    if (adhesiveConsumption.deducted) {
      message +=
        ` Adhesive: ${adhesiveConsumption.used} kg off ${adhesiveConsumption.deducted} drum${adhesiveConsumption.deducted === 1 ? "" : "s"}` +
        `${adhesiveConsumption.emptied ? ` (${adhesiveConsumption.emptied} emptied)` : ""}.`;
    }
    if (releaseConsumption.deducted) {
      message +=
        ` Release Liner: ${releaseConsumption.used} kg off ${releaseConsumption.deducted} reel${releaseConsumption.deducted === 1 ? "" : "s"}` +
        `${releaseConsumption.emptied ? ` (${releaseConsumption.emptied} emptied)` : ""}.`;
    }
    if (deckleProduction.created) {
      const ids = deckleProduction.rows.filter(Boolean);
      message +=
        ` Produced: ${deckleProduction.meters} mtrs as ${deckleProduction.created} Deckle${deckleProduction.created === 1 ? "" : "s"}` +
        `${ids.length ? ` (${ids.join(", ")})` : ""} — inwarded to Semi-Finished Stock.`;
    }

    return {
      status: "ok",
      jobCardId,
      pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new",
      message,
      consumption,
      facestockConsumption,
      adhesiveConsumption,
      releaseConsumption,
      deckleProduction,
      productionProgress,
    };
  } catch (err) {
    // Two submits of the same page racing past the pre-check both reach
    // create; the loser trips the unique submissionToken index. That's a
    // duplicate, not a failure.
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      return { status: "duplicate", pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new" };
    }
    throw err;
  }
}

router.post("/machine/jobcard/form", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const result = await saveMachineJobCard({
      body: req.body,
      actorName: req.session?.authUser?.username || req.session?.authUser?.empName,
    });

    if (result.status === "duplicate") {
      return res.redirect(`/sachiko/machine/jobcard/view?saved=${encodeURIComponent(result.pendingId)}`);
    }
    if (result.status === "gate-failed" || result.status === "wip-clash") {
      req.flash("notification", result.message);
      return res.redirect(
        mongoose.isValidObjectId(result.machineId) ? `/sachiko/machine/${result.machineId}/queue` : "/sachiko/machine/queue",
      );
    }

    req.flash("notification", result.message);
    return res.redirect(`/sachiko/machine/jobcard/view?saved=${encodeURIComponent(result.pendingId)}`);
  } catch (err) {
    console.error("JOB CARD CREATE ERROR:", err);
    req.flash("notification", "Failed to save production entry");
    res.redirect("back");
  }
});

router.get("/machine/jobcard/view", requireMachineFloor, async (req, res) => {
  const jsonData = await MachineJobCard.find()
    .populate({ path: "pendingProductionId", select: "deckleSize materialSwapLog" })
    .sort({ createdAt: -1 })
    .lean();

  // ---- Per-deckle reel breakdown for the "Deckles Produced" dialog, in the
  //      same shape as /sachiko/semifinishedstock's view dialog (Layer / Reel
  //      ID / Spec / Kg Used / Status / Remark). Spec is read off the raw
  //      reel's own Stock row (kept at qty 0 after it is consumed); Kg Used
  //      comes from this Job Card's end-of-job *Usage arrays, falling back to
  //      the order's materialSwapLog for a reel swapped out mid-run, then
  //      pro-rated across every Deckle row on the card that shared the reel
  //      (same reasoning as semiFinishedStock.js); Remark is the swap reason. ----
  const jcNorm = (v) => String(v || "").trim().toUpperCase();
  const jcReelMatches = (entry, sid, rid) =>
    (sid && String(entry.stockId) === sid) || (rid && jcNorm(entry.rollId) === rid);
  const jcCompact = (parts) => parts.filter((p) => p != null && p !== "").join(" · ");
  const POOL_ROLL_FIELD = { facestock: "fsRollId", adhesive: "adRollId", release: "rlRollId" };
  const reelsOfRow = (row) => {
    const list = Array.isArray(row.materialsUsed) && row.materialsUsed.length
      ? row.materialsUsed.map((m) => ({ pool: m.pool, stockId: m.stockId, rollId: m.rollId }))
      : Object.entries(POOL_ROLL_FIELD)
          .map(([pool, f]) => (row[f] ? { pool, rollId: row[f] } : null))
          .filter(Boolean);
    return list.filter((r) => r && r.rollId);
  };

  const wantByPool = { facestock: new Set(), adhesive: new Set(), release: new Set() };
  for (const jc of jsonData) {
    for (const row of jc.productionLog || []) {
      for (const r of reelsOfRow(row)) {
        if (wantByPool[r.pool]) wantByPool[r.pool].add(jcNorm(r.rollId));
      }
    }
  }

  const [fsReels, adReels, rlReels] = await Promise.all([
    FacestockStock.find({ rollId: { $in: [...wantByPool.facestock] } }).select("rollId type size gsm micron").lean(),
    AdhesiveStock.find({ rollId: { $in: [...wantByPool.adhesive] } }).select("rollId type gsm").lean(),
    ReleaseLinerStock.find({ rollId: { $in: [...wantByPool.release] } }).select("rollId type color size gsm").lean(),
  ]);
  const specByRoll = new Map();
  for (const r of fsReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.gsm ? `${r.gsm} GSM` : "", r.micron ? `${r.micron} MIC` : "", r.size ? `${r.size} mm` : ""]));
  for (const r of adReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.gsm ? `${r.gsm} GSM` : ""]));
  for (const r of rlReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.color, r.gsm ? `${r.gsm} GSM` : "", r.size ? `${r.size} mm` : ""]));

  for (const jc of jsonData) {
    const usageByPool = {
      facestock: Array.isArray(jc.facestockUsage) ? jc.facestockUsage : [],
      adhesive: Array.isArray(jc.adhesiveUsage) ? jc.adhesiveUsage : [],
      release: Array.isArray(jc.releaseUsage) ? jc.releaseUsage : [],
    };
    const swaps = Array.isArray(jc.pendingProductionId?.materialSwapLog) ? jc.pendingProductionId.materialSwapLog : [];
    const logRows = Array.isArray(jc.productionLog) ? jc.productionLog : [];

    for (const row of logRows) {
      row.reelDetails = reelsOfRow(row).map((r) => {
        const sid = r.stockId ? String(r.stockId) : "";
        const rid = jcNorm(r.rollId);
        const usage = usageByPool[r.pool]?.find((u) => jcReelMatches(u, sid, rid));
        const swap = swaps.find((s) => s.pool === r.pool && jcReelMatches(s, sid, rid));
        let kg = null;
        if (usage) {
          const v = usage.kgUsed != null ? usage.kgUsed : usage.mtrsUsed;
          if (Number.isFinite(Number(v))) kg = Number(v);
        }
        if (kg == null && swap && Number.isFinite(Number(swap.usedKg))) kg = Number(swap.usedKg);
        if (kg != null) {
          const sharing = logRows.filter((rr) =>
            reelsOfRow(rr).some((x) => (x.pool || r.pool) === r.pool && jcReelMatches(x, sid, rid)));
          if (sharing.length > 1) {
            const totalMtrs = sharing.reduce((n, rr) => n + (Number(rr.meters) || 0), 0);
            const thisMtrs = Number(row.meters) || 0;
            kg = totalMtrs > 0 && thisMtrs > 0
              ? Math.round(kg * (thisMtrs / totalMtrs) * 100) / 100
              : Math.round((kg / sharing.length) * 100) / 100;
          } else {
            kg = Math.round(kg * 100) / 100;
          }
        }
        return {
          pool: r.pool || "",
          rollId: r.rollId || "",
          spec: specByRoll.get(rid) || "",
          kgUsed: kg,
          remark: swap?.reason ? String(swap.reason).trim() : "",
        };
      });
    }
  }

  res.render("inventory/masters/jobCardView.ejs", {
    title: "Production Records",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

export default router;
