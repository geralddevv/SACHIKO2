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
import MachineJobCard from "../../models/inventory/machineJobCard.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";
import { normalizeRollId, extractScannedRollId, generateDeckleId } from "../../utils/rollId.js";
import { requiredLayersFor, LAYER_META, POOL_MODELS, pickStockIds } from "../../utils/labelStockProduction.js";

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
function hasStartableAllotment({ rollType, allottedLayers, allottedRollIds }) {
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

async function previewId(key, code) {
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
    if (!stockId || !Number.isFinite(amount) || amount <= 0) continue;
    byStockId.set(stockId, round2((byStockId.get(stockId) || 0) + amount));
  }
  return [...byStockId].map(([stockId, amount]) => ({ stockId, [amountKey]: amount }));
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
router.get("/operator/queue", requireRole(["operator"]), async (req, res) => {
  const authUser = req.session?.authUser;
  const operatorObjId = authUser?.empObjId;

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

  res.render("inventory/masters/operatorQueue.ejs", {
    title: "Work Queue",
    CSS: "tableDisp.css",
    JS: false,
    operatorName: authUser?.empName || "",
    operatorLocation: authUser?.empLoc || "",
    groups,
    totalJobs: rows.length,
    openMaintenanceCount,
    notification: req.flash("notification"),
  });
});

// Shared by the per-machine queue page, the queue overview's card view and the
// job card form's prefill lookup. Takes a match filter rather than a single
// id so the overview can build every machine's jobs in one pass instead of
// one round of queries per machine.
async function buildQueueRows(match) {
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
    // Sachiko's Label Stock orders already collect No. of Rolls/Running
    // Meters directly at order entry -- unlike FAIRTECH, nothing here is
    // computed from a die.
    const rolls = p.noOfRolls != null ? Number(p.noOfRolls) : null;
    const allottedRolls = p.allottedRolls != null ? p.allottedRolls : null;
    const balanceRolls =
      rolls == null ? null : allottedRolls == null ? rolls : Math.max(rolls - allottedRolls, 0);
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
      p.runningMeters != null ? `${Number(p.runningMeters).toLocaleString("en-IN")} m` : "";

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

    return {
      _id: String(p._id),
      machineId: String(p.assignedMachineId || ""),
      lotNo: p.lotNo || "—",
      productCode: item.productCode || item.skuCode || "—",
      paperSize: p.paperSize || "—",
      rolls: rolls != null ? String(rolls) : "—",
      allottedRolls: allottedRolls != null ? String(allottedRolls) : "—",
      balanceRolls: balanceRolls != null ? String(balanceRolls) : "—",
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

  if (pendingId && mongoose.isValidObjectId(pendingId)) {
    const pendingDoc = await PendingProduction.findById(pendingId).select("assignedMachineId").lean();
    if (pendingDoc?.assignedMachineId) {
      machine = await Machine.findById(pendingDoc.assignedMachineId).lean();
      const rows = await buildQueueRows({ assignedMachineId: pendingDoc.assignedMachineId });
      prefill = rows.find((r) => r._id === String(pendingId)) || null;
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
async function consumeAllottedRollMeters({ pendingProductionId, logRows, jobCardId, createdBy }) {
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

// Deducts the mtrs/kg the operator reports using off each reel this job had
// reserved for one raw-material pool (Facestock, Adhesive, or Release Liner)
// -- the "Material Used" dialog on Save Production Entry
// (views/inventory/masters/jobCardForm.ejs) is the only place any of these
// three pools' reels actually leave Stock for an order allotted through the
// newer layerAllotments picker (PendingProduction.allottedLayers): unlike
// the older allottedRollIds flow, consumeAllottedRollMeters above has no
// scanned Deckle roll length to derive Facestock/Release Liner consumption
// from here -- and Adhesive never had one to begin with (a drum has no
// length reading to scan, only a weight). The operator has to say how much
// of each reel the job actually used.
//
// `rows` is [{ stockId, used }], already validated against the job's own
// PendingProduction.allottedLayers[pool] by the caller -- this only re-reads
// the live reels to know how much is really left on each and mirrors
// produceDeckle's own deduction shape (utils/labelStockProduction.js) so
// every path that can reduce one of these reels agrees on how it does it
// (reelMtrs clamped at 0, quantity zeroed once emptied, one OUTWARD
// *StockLog line per reel). Facestock/Release Liner reels count reelMtrs in
// metres; Adhesive drums count it in kg -- same field, different unit, hence
// the caller-supplied `pool` picking the right word for the log remark.
async function consumePoolUsage({ pool, rows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, used: 0, rows: [], limited: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const { Model, LogModel } = POOL_MODELS[pool];
  const unitLabel = pool === "adhesive" ? "kg" : "mtrs";
  const requestedByStockId = new Map();
  for (const row of rows) {
    const stockId = trim(row?.stockId);
    const used = round2(Number(row?.used) || 0);
    if (stockId && used > 0) requestedByStockId.set(stockId, round2((requestedByStockId.get(stockId) || 0) + used));
  }
  const stockIds = [...requestedByStockId.keys()];
  const reels = stockIds.length
    ? await Model.find({ _id: { $in: stockIds } }).select("rollId type location quantity reelMtrs rate").lean()
    : [];
  const reelById = new Map(reels.map((d) => [String(d._id), d]));

  for (const [stockId, requested] of requestedByStockId) {
    const reel = reelById.get(stockId);
    if (!reel) continue;

    // The dialog validates this in the browser, but stock can change between
    // opening it and saving. Record only what is really available; never let
    // a stale/tampered request create a negative balance or an overstated log.
    const available = Math.max(round2(Number(reel.reelMtrs) || 0), 0);
    const used = Math.min(requested, available);
    if (used <= 0) {
      result.limited.push({ stockId: reel._id, rollId: reel.rollId, requested, used: 0 });
      continue;
    }
    if (used < requested) result.limited.push({ stockId: reel._id, rollId: reel.rollId, requested, used });

    const remaining = round2(available - used);
    const emptied = remaining <= 0;

    const bal = await Model.aggregate([
      { $match: { type: reel.type, location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;

    await Model.updateOne(
      { _id: reel._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

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
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}${used} ${unitLabel} consumed${emptied ? " — reel emptied" : ""}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.deducted += 1;
    result.used = round2(result.used + used);
    if (emptied) result.emptied += 1;
    result.rows.push({ stockId: reel._id, rollId: reel.rollId, used });
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
async function produceDecklesFromLog({ pendingDoc, productionLog, location, jobCardId, createdBy }) {
  const result = { rows: [], created: 0, meters: 0 };
  const labelStockId = pendingDoc?.itemId?._id || pendingDoc?.itemId;
  if (!labelStockId || !location || !Array.isArray(productionLog) || !productionLog.length) return result;

  const labelStock = await SachikoLabelStock.findById(labelStockId).select("productCode skuCode").lean();
  const itemCode = labelStock?.productCode || labelStock?.skuCode;
  if (!itemCode) return result;

  for (let i = 0; i < productionLog.length; i++) {
    const row = productionLog[i];
    const meters = round2(Number(row.meters) || 0);
    if (meters <= 0) {
      result.rows.push(null);
      continue;
    }

    const deckleId = await generateDeckleId(itemCode, pendingDoc.lotNo);
    // The job card records the status of both webs. Preserve the actual
    // selected value(s) on this particular finished reel for its SOFT.prn
    // JOINTS field, while omitting it completely for a clean run.
    const joints = [...new Set([row.face?.joint, row.release?.joint]
      .map((value) => trim(value))
      .filter(Boolean))]
      .join(" / ") || undefined;

    const bal = await MaterialStock.aggregate([
      { $match: { material: labelStock._id, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;

    await MaterialStock.create({
      material: labelStock._id,
      location,
      quantity: 1,
      reelMtrs: meters,
      size: trim(pendingDoc.paperSize),
      joints,
      lotNo: trim(pendingDoc.lotNo),
      rollId: deckleId,
      producedFor: pendingDoc._id,
    });

    await MaterialStockLog.create({
      material: labelStock._id,
      location,
      openingStock,
      quantity: 1,
      closingStock: openingStock + 1,
      reelMtrs: meters,
      rollId: deckleId,
      type: "INWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}Deckle produced from Production Log row ${i + 1}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.rows.push(deckleId);
    result.created += 1;
    result.meters = round2(result.meters + meters);
  }
  return result;
}

router.post("/machine/jobcard/form", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const b = req.body;

    // Idempotency: a resubmit of the same loaded page carries the same
    // token. If one already saved, don't create a second entry or deduct
    // stock again -- just send them on to the records.
    const submissionToken = trim(b.submissionToken);
    if (submissionToken) {
      const already = await MachineJobCard.findOne({ submissionToken }).select("_id").lean();
      if (already) {
        const savedFor = mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new";
        return res.redirect(`/sachiko/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
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
        .select("allottedRollIds allottedLayers itemId paperSize lotNo")
        .populate({ path: "itemId", select: "rollType" })
        .lean();
      if (!pendingDoc || !hasStartableAllotment({
        rollType: pendingDoc.itemId?.rollType,
        allottedLayers: pendingDoc.allottedLayers,
        allottedRollIds: pendingDoc.allottedRollIds,
      })) {
        req.flash("notification", "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.");
        return res.redirect(
          mongoose.isValidObjectId(b.machineId) ? `/sachiko/machine/${b.machineId}/queue` : "/sachiko/machine/queue"
        );
      }
    }

    // Where each new Deckle this job produces gets inwarded -- the same
    // location its own raw material already sits at (Assign Production's
    // reel pickers are scoped to one location per order, so every layer
    // agrees anyway). Facestock is checked first since every roll type calls
    // for it; release liner is the fallback for the one hypothetical recipe
    // that somehow doesn't (there isn't one today, but nothing enforces it).
    let deckleLocation = "";
    if (pendingDoc?.allottedLayers) {
      for (const key of ["facestock", "facestock2", "adhesive", "adhesive2", "releaseLiner", "releaseLiner2"]) {
        const pick = pendingDoc.allottedLayers[key];
        const sids = pickStockIds(pick);
        if (!pick?.pool || !sids.length) continue;
        const { Model } = POOL_MODELS[pick.pool];
        const doc = await Model.findById(sids[0]).select("location").lean();
        if (doc?.location) { deckleLocation = doc.location; break; }
      }
    }

    // Material Used dialog rows -- one per reel this order actually had
    // reserved, per pool (facestockStockId[]/facestockMtrsUsed[],
    // adhesiveStockId[]/adhesiveKgUsed[], releaseStockId[]/
    // releaseMtrsUsed[], each its own parallel-array pair, same convention as
    // Job Setting/Production Log above). Only a stockId that's genuinely one
    // of this order's own allottedLayers picks for that pool is kept -- the
    // dialog only ever offers those, but the form is still a POST body, not
    // a trusted source.
    const validStockIdsForPool = (pool, keys) => new Set(
      keys
        .map((key) => pendingDoc?.allottedLayers?.[key])
        .filter((pick) => pick?.pool === pool)
        .flatMap((pick) => pickStockIds(pick)),
    );

    const validFacestockStockIds = validStockIdsForPool("facestock", ["facestock", "facestock2"]);
    const fsStockId = toArray(b.facestockStockId);
    const fsMtrsUsed = toArray(b.facestockMtrsUsed);
    const facestockUsage = consolidateUsageRows(
      fsStockId
        .map((sid, i) => ({ stockId: trim(sid), mtrsUsed: numOrUndef(fsMtrsUsed[i]) }))
        .filter((row) => row.stockId && validFacestockStockIds.has(row.stockId) && row.mtrsUsed != null && row.mtrsUsed > 0),
      "mtrsUsed",
    );

    const validAdhesiveStockIds = validStockIdsForPool("adhesive", ["adhesive", "adhesive2"]);
    const adKgStockId = toArray(b.adhesiveStockId);
    const adKgUsed = toArray(b.adhesiveKgUsed);
    const adhesiveUsage = consolidateUsageRows(
      adKgStockId
        .map((sid, i) => ({ stockId: trim(sid), kgUsed: numOrUndef(adKgUsed[i]) }))
        .filter((row) => row.stockId && validAdhesiveStockIds.has(row.stockId) && row.kgUsed != null && row.kgUsed > 0),
      "kgUsed",
    );

    const validReleaseStockIds = validStockIdsForPool("release", ["releaseLiner", "releaseLiner2"]);
    const rlStockId = toArray(b.releaseStockId);
    const rlMtrsUsed = toArray(b.releaseMtrsUsed);
    const releaseUsage = consolidateUsageRows(
      rlStockId
        .map((sid, i) => ({ stockId: trim(sid), mtrsUsed: numOrUndef(rlMtrsUsed[i]) }))
        .filter((row) => row.stockId && validReleaseStockIds.has(row.stockId) && row.mtrsUsed != null && row.mtrsUsed > 0),
      "mtrsUsed",
    );

    const jobCardId = await generateId("machineJobCardId", "JC");

    // Job Setting rows
    const jsRollId = toArray(b.jsRollId);
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => ({
        rollId: trim(jsRollId[i]),
        mtrs1: numOrUndef(jsMtrs1[i]),
        startTime: trim(jsStart[i]),
        mtrs2: numOrUndef(jsMtrs2[i]),
        stopTime: trim(jsStop[i]),
      }))
      .filter((row) => row.rollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows -- one per deckle produced, so unlike Job Setting
    // above these carry the deckle's own metres rather than a start/stop
    // counter pair, plus the joint/wrinkle noted on each web.
    const rollId = toArray(b.rollId);
    const deckleId = toArray(b.deckleId);
    const logStart = toArray(b.logStart);
    const logEnd = toArray(b.logEnd);
    const logMeters = toArray(b.logMeters);
    const faceJoint = toArray(b.faceJoint);
    const faceMtr = toArray(b.faceMtr);
    const releaseJoint = toArray(b.releaseJoint);
    const releaseMtr = toArray(b.releaseMtr);
    const productionLog = rollId
      .map((_, i) => ({
        rollId: trim(rollId[i]),
        deckleId: trim(deckleId[i]),
        meters: numOrUndef(logMeters[i]),
        face: { joint: trim(faceJoint[i]), mtr: numOrUndef(faceMtr[i]) },
        release: { joint: trim(releaseJoint[i]), mtr: numOrUndef(releaseMtr[i]) },
        time: { startTime: trim(logStart[i]), endTime: trim(logEnd[i]) },
      }))
      .filter(
        (row) =>
          row.rollId ||
          row.deckleId ||
          row.meters != null ||
          row.face.mtr != null ||
          row.release.mtr != null ||
          row.time.startTime ||
          row.time.endTime,
      );

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
        rollDrumNo: trim(b.fsRollDrumNo),
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
      },
      adhesive: {
        rollDrumNo: trim(b.adRollDrumNo),
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
      },
      releaseLiner: {
        rollDrumNo: trim(b.rlRollDrumNo),
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
        createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
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
        rows: facestockUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed })),
        jobCardId,
        createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
      });
      // Fills in the rollId snapshot the create above couldn't (the reel
      // docs are only read inside consumePoolUsage itself) -- purely
      // cosmetic for the saved card, the deduction already happened above
      // regardless of whether this write succeeds.
      if (facestockConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { facestockUsage: facestockConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used })) } },
        );
      }
    } catch (fsErr) {
      console.error("JOB CARD FACESTOCK DEDUCTION ERROR:", fsErr);
    }

    let adhesiveConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      adhesiveConsumption = await consumePoolUsage({
        pool: "adhesive",
        rows: adhesiveUsage.map((r) => ({ stockId: r.stockId, used: r.kgUsed })),
        jobCardId,
        createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
      });
      if (adhesiveConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { adhesiveUsage: adhesiveConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, kgUsed: r.used })) } },
        );
      }
    } catch (adErr) {
      console.error("JOB CARD ADHESIVE DEDUCTION ERROR:", adErr);
    }

    let releaseConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      releaseConsumption = await consumePoolUsage({
        pool: "release",
        rows: releaseUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed })),
        jobCardId,
        createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
      });
      if (releaseConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { releaseUsage: releaseConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used })) } },
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
        location: deckleLocation,
        jobCardId,
        createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
      });
      if (deckleProduction.created) {
        await MachineJobCard.updateOne(
          { jobCardId },
          {
            $set: productionLog.reduce((set, _row, i) => {
              if (deckleProduction.rows[i]) set[`productionLog.${i}.deckleId`] = deckleProduction.rows[i];
              return set;
            }, {}),
          },
        );
      }
    } catch (deckleErr) {
      console.error("JOB CARD DECKLE PRODUCTION ERROR:", deckleErr);
    }

    // The job is done: take it off the machine and operator queues by
    // stamping the pending order as produced.
    if (mongoose.isValidObjectId(b.pendingId)) {
      try {
        await PendingProduction.updateOne(
          { _id: b.pendingId },
          { $set: { producedAt: new Date() } },
        );
      } catch (prodErr) {
        console.error("JOB CARD MARK-PRODUCED ERROR:", prodErr);
      }
    }

    let message = "Production entry saved successfully!";
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
        ` Facestock: ${facestockConsumption.used} mtrs off ${facestockConsumption.deducted} reel${facestockConsumption.deducted === 1 ? "" : "s"}` +
        `${facestockConsumption.emptied ? ` (${facestockConsumption.emptied} emptied)` : ""}.`;
    }
    if (adhesiveConsumption.deducted) {
      message +=
        ` Adhesive: ${adhesiveConsumption.used} kg off ${adhesiveConsumption.deducted} drum${adhesiveConsumption.deducted === 1 ? "" : "s"}` +
        `${adhesiveConsumption.emptied ? ` (${adhesiveConsumption.emptied} emptied)` : ""}.`;
    }
    if (releaseConsumption.deducted) {
      message +=
        ` Release Liner: ${releaseConsumption.used} mtrs off ${releaseConsumption.deducted} reel${releaseConsumption.deducted === 1 ? "" : "s"}` +
        `${releaseConsumption.emptied ? ` (${releaseConsumption.emptied} emptied)` : ""}.`;
    }
    if (deckleProduction.created) {
      const ids = deckleProduction.rows.filter(Boolean);
      message +=
        ` Produced: ${deckleProduction.meters} mtrs as ${deckleProduction.created} Deckle${deckleProduction.created === 1 ? "" : "s"}` +
        `${ids.length ? ` (${ids.join(", ")})` : ""} — inwarded to Semi-Finished Stock.`;
    }
    req.flash("notification", message);
    const savedFor = mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new";
    res.redirect(`/sachiko/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
  } catch (err) {
    // Two submits of the same page racing past the pre-check both reach
    // create; the loser trips the unique submissionToken index. That's a
    // duplicate, not a failure.
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      const savedFor = mongoose.isValidObjectId(req.body.pendingId) ? String(req.body.pendingId) : "new";
      return res.redirect(`/sachiko/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
    }
    console.error("JOB CARD CREATE ERROR:", err);
    req.flash("notification", "Failed to save production entry");
    res.redirect("back");
  }
});

router.get("/machine/jobcard/view", requireMachineFloor, async (req, res) => {
  const jsonData = await MachineJobCard.find().sort({ createdAt: -1 }).lean();
  res.render("inventory/masters/jobCardView.ejs", {
    title: "Production Records",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

export default router;
