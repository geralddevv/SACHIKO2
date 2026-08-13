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
import { normalizeRollId, extractScannedRollId } from "../../utils/rollId.js";

const router = express.Router();

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
    .populate({ path: "itemId", select: "productCode skuCode facestock adhesive releaseLiner" })
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
      quantity: qty,
      balanceQuantity: balanceQty,
      clientName: p.userId?.clientName || p.userId?.userName || "—",
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      allottedRollDetails,
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

  // No physical reels ticked on Assign Production yet -- starting the job
  // card would let the operator scan against material that was never
  // actually set aside, so send them back to the queue instead of opening
  // the form.
  if (prefill && (!prefill.allottedRollDetails || prefill.allottedRollDetails.length === 0)) {
    req.flash("notification", "Assign facestock rolls to this order before starting production.");
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

// Metres a single production-log row consumed: the counter runs up during a
// job, so it's the stop reading minus the start reading.
const consumedMeters = (row) => {
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
    // start a job with no reels actually set aside for it.
    if (mongoose.isValidObjectId(b.pendingId)) {
      const pendingDoc = await PendingProduction.findById(b.pendingId).select("allottedRollIds").lean();
      if (!pendingDoc?.allottedRollIds?.length) {
        req.flash("notification", "Assign facestock rolls to this order before starting production.");
        return res.redirect(
          mongoose.isValidObjectId(b.machineId) ? `/sachiko/machine/${b.machineId}/queue` : "/sachiko/machine/queue"
        );
      }
    }

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

    // Production Log rows -- same shape as Job Setting above
    const rollId = toArray(b.rollId);
    const logMtrs1 = toArray(b.logMtrs1);
    const logStart = toArray(b.logStart);
    const logMtrs2 = toArray(b.logMtrs2);
    const logStop = toArray(b.logStop);
    const productionLog = rollId
      .map((_, i) => ({
        rollId: trim(rollId[i]),
        mtrs1: numOrUndef(logMtrs1[i]),
        startTime: trim(logStart[i]),
        mtrs2: numOrUndef(logMtrs2[i]),
        stopTime: trim(logStop[i]),
      }))
      .filter((row) => row.rollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

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
