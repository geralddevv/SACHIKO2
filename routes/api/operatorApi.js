import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import Location from "../../models/system/location.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import Machine from "../../models/system/machine.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import { authenticateOperator } from "../../utils/operatorAuth.js";
import { signOperatorApiToken, requireOperatorApiAuth, requireOperatorApiMediaAuth } from "../../middleware/apiAuth.js";
import { buildFacestockRollLabelPrn } from "../../utils/facestockRollLabel.js";
import { buildAdhesiveRollLabelPrn } from "../../utils/adhesiveRollLabel.js";
import { buildReleaseLinerRollLabelPrn } from "../../utils/releaseLinerRollLabel.js";
import { buildMaterialStockRollLabelPrn } from "../../utils/materialStockRollLabel.js";
import { loginLimiter, createLimiter } from "../../utils/limiters.js";
import { POOL_MODELS, pickStockIds, getEligibleRawMaterials } from "../../utils/labelStockProduction.js";
import { extractScannedRollId } from "../../utils/rollId.js";
import {
  buildQueueRows,
  buildOperatorQueue,
  previewId,
  saveMachineJobCard,
  reelsInUseElsewhere,
  produceDecklesFromLog,
  consumePoolUsage,
  resolveDeckleLocation,
  resolveScannedCombinationVariant,
} from "../system/machine.js";
import {
  createOperatorTicket,
  toMaintenanceRow,
  resolveOperatorMachine,
  listMachinesAtLocation,
  serveMaintenanceAsset,
  maintenanceUpload,
  MaintenanceInputError,
} from "../system/maintenance.js";

/*
 * JSON API for the Sachiko Operator mobile app (a separate bare React Native
 * project, sibling to FairtechOperatorApp/FAIRTECH-ERP's own operatorApi.js
 * which this file is deliberately modeled on). Every other route in this
 * codebase is server-rendered EJS with cookie-session auth + CSRF, neither of
 * which a native client can use naturally -- this router is bearer-token
 * authenticated instead (see middleware/apiAuth.js) and mounted in server.js
 * *before* the global CSRF middleware, the same "exempt from CSRF" pattern
 * already used for /check-session.
 *
 * All business logic here is reused, not reimplemented, from
 * routes/system/machine.js's and routes/system/maintenance.js's exports --
 * this file is deliberately thin. Where the EJS route has no per-operator
 * ownership check (staff can open any job there), the routes below add one:
 * the mobile app is operator-only, so ownership has to be enforced
 * explicitly rather than falling out of "which page can you even reach."
 */
const router = express.Router();

router.post("/login", loginLimiter, async (req, res) => {
  const { operatorNick, location } = req.body || {};
  const rawPw = (req.body || {}).password;
  const password = Array.isArray(rawPw) ? rawPw[0] : rawPw;
  const result = await authenticateOperator({ operatorNick, location, password });
  if (result.error) {
    return res.status(result.status || 401).json({ error: result.error });
  }

  const { authUser } = result;
  const token = signOperatorApiToken(authUser);
  res.json({
    token,
    empName: authUser.empName,
    empNickName: authUser.empNickName,
    empLoc: authUser.empLoc,
    empObjId: authUser.empObjId,
    empPhoto: authUser.empPhoto,
    profileCode: authUser.profileCode,
  });
});

router.get("/locations", async (req, res) => {
  const locations = await Location.find({}).sort({ locationName: 1 }).select("locationName").lean();
  res.json({ locations: locations.map((l) => l.locationName) });
});

router.get("/queue", requireOperatorApiAuth, async (req, res) => {
  const queue = await buildOperatorQueue({
    empObjId: req.authUser.empObjId,
    empName: req.authUser.empName,
    empNickName: req.authUser.empNickName,
    empLoc: req.authUser.empLoc,
  });
  res.json(queue);
});

router.get("/jobcard/:pendingId", requireOperatorApiAuth, async (req, res) => {
  const { pendingId } = req.params;
  if (!mongoose.isValidObjectId(pendingId)) {
    return res.status(400).json({ error: "Invalid pendingId" });
  }

  const pendingDoc = await PendingProduction.findById(pendingId)
    .select("assignedMachineId itemId allottedLayers materialSwapLog operatorId")
    .lean();
  if (!pendingDoc) {
    return res.status(404).json({ error: "Not found" });
  }
  if (String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  let machine = null;
  let prefill = null;
  let eligibleRawStock = { facestock: [], adhesive: [], release: [] };
  if (pendingDoc.assignedMachineId) {
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

  // Same precedence as the EJS GET /machine/jobcard/form: a dead/stale
  // pendingId first, then the allotment gate.
  if (!prefill) {
    return res.status(404).json({ error: "That production order no longer exists — pick a job from the queue." });
  }
  if (!prefill.canStart) {
    return res.status(409).json({
      error: "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.",
    });
  }

  const previewJobCardId = await previewId("machineJobCardId", "JC");
  res.json({
    pendingId: String(pendingId),
    machine,
    prefill,
    previewJobCardId,
    eligibleRawStock,
    materialSwapLog: pendingDoc.materialSwapLog || [],
    submissionToken: randomUUID(),
  });
});

router.post("/jobcard/material/check", requireOperatorApiAuth, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId, mounted } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) return res.status(400).json({ ok: false, code: "bad-request" });
    if (!POOL_MODELS[pool]) return res.status(400).json({ ok: false, code: "bad-request" });
    const cleanId = extractScannedRollId(rollId);
    if (!cleanId) return res.json({ ok: false, code: "unknown" });

    const pendingDoc = await PendingProduction.findById(pendingId).select("itemId allottedLayers operatorId").lean();
    if (!pendingDoc) return res.status(404).json({ ok: false, code: "no-order" });
    if (String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ ok: false, code: "forbidden" });
    }

    const reel = await POOL_MODELS[pool].Model.findOne({ rollId: cleanId }).lean();
    if (!reel) return res.json({ ok: false, code: "unknown" });

    const eligible = await getEligibleRawMaterials({
      labelStock: pendingDoc.itemId,
      allottedLayers: pendingDoc.allottedLayers,
    });
    const matchesRecipe = eligible.validStockIds?.[pool]?.has(String(reel._id));

    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(reel._id)}`);
    if (wip) {
      return res.json({ ok: false, code: "wip", rollId: reel.rollId, lotNo: wip.lotNo, machineName: wip.machineName });
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
      console.error("OPERATOR API MATERIAL CHECK VARIANT ERROR:", variantErr);
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
    console.error("OPERATOR API MATERIAL CHECK ERROR:", err);
    res.status(500).json({ ok: false, code: "error" });
  }
});

router.post("/jobcard/mark-in-use", requireOperatorApiAuth, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) return res.status(400).json({ success: false });
    const poolInfo = POOL_MODELS[pool];
    if (!poolInfo) return res.status(400).json({ success: false });

    const pendingDoc = await PendingProduction.findById(pendingId).select("operatorId").lean();
    if (!pendingDoc || String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ success: false });
    }

    const cleanId = extractScannedRollId(rollId);
    if (!cleanId) return res.status(400).json({ success: false });

    const reel = await poolInfo.Model.findOne({ rollId: cleanId }).select("_id rollId").lean();
    if (!reel) return res.status(404).json({ success: false });

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
    console.error("OPERATOR API MARK-IN-USE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

router.post("/jobcard/log/produce", requireOperatorApiAuth, createLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.pendingId)) {
      return res.status(400).json({ success: false, message: "Missing or invalid production order." });
    }
    const meters = Number(b.meters);
    if (!meters || meters <= 0) {
      return res.status(400).json({ success: false, message: "Enter the produced metres first." });
    }

    const rowToken = String(b.rowToken || "").trim() || undefined;
    if (rowToken) {
      const priorDeckle = await MaterialStock.findOne({ productionRowToken: rowToken })
        .select("rollId reelMtrs location material sourceReels")
        .populate({ path: "material", select: "productCode" })
        .lean();
      if (priorDeckle) {
        return res.json({
          success: true,
          deckleId: priorDeckle.rollId,
          deckleStockId: String(priorDeckle._id),
          meters: Number(priorDeckle.reelMtrs) || 0,
          location: priorDeckle.location || "",
          productCode: priorDeckle.material?.productCode || "",
          sourceReels: priorDeckle.sourceReels || [],
          replayed: true,
        });
      }
    }

    const pendingDoc = await PendingProduction.findById(b.pendingId)
      .select("allottedLayers itemId paperSize lotNo operatorId")
      .lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }
    if (String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const deckleLocation = await resolveDeckleLocation(pendingDoc);
    if (!deckleLocation) {
      return res.status(400).json({ success: false, message: "Couldn't resolve a stock location for this order." });
    }

    const trim = (v) => String(v ?? "").trim();
    const fs = trim(b.fsRollId);
    const ad = trim(b.adRollId);
    const rl = trim(b.rlRollId);
    const materialsUsed = Array.isArray(b.materialsUsed)
      ? b.materialsUsed
          .filter((m) => m && m.pool && (m.rollId || m.stockId))
          .map((m) => ({
            pool: trim(m.pool),
            rollId: trim(m.rollId),
            stockId: mongoose.isValidObjectId(m.stockId) ? m.stockId : undefined,
          }))
      : [];
    const row = {
      rollId: fs || [fs, ad, rl].filter(Boolean).join(", "),
      fsRollId: fs,
      adRollId: ad,
      rlRollId: rl,
      materialsUsed,
      deckleId: "",
      rowToken,
      startMtrs: b.startMtrs != null && b.startMtrs !== "" ? Number(b.startMtrs) : undefined,
      stopMtrs: b.stopMtrs != null && b.stopMtrs !== "" ? Number(b.stopMtrs) : undefined,
      meters,
      face: { joint: trim(b.faceJoint), mtr: b.faceMtr != null && b.faceMtr !== "" ? Number(b.faceMtr) : undefined },
      release: { joint: trim(b.releaseJoint), mtr: b.releaseMtr != null && b.releaseMtr !== "" ? Number(b.releaseMtr) : undefined },
      time: { startTime: trim(b.startTime), endTime: trim(b.endTime) },
    };

    const production = await produceDecklesFromLog({
      pendingDoc,
      productionLog: [row],
      location: deckleLocation,
      createdBy: req.authUser.empName,
    });

    const deckleId = production.rows[0];
    if (!deckleId) {
      return res.status(400).json({ success: false, message: "Couldn't produce a Deckle for this row." });
    }

    // Firm the reel reservation, best-effort -- see the EJS route's own
    // comment on this same block in routes/system/machine.js.
    try {
      const addToSet = {};
      for (const sr of production.rowMeta?.[0]?.sourceReels || []) {
        if (!sr?.pool || !POOL_MODELS[sr.pool] || !mongoose.isValidObjectId(sr.stockId)) continue;
        const key = `liveMaterialInUse.${sr.pool}`;
        (addToSet[key] ||= { $each: [] }).$each.push(new mongoose.Types.ObjectId(String(sr.stockId)));
      }
      if (Object.keys(addToSet).length) {
        await PendingProduction.updateOne({ _id: b.pendingId }, { $addToSet: addToSet });
      }
    } catch (lockErr) {
      console.error("OPERATOR API INSTANT DECKLE LOCK ERROR:", lockErr);
    }

    res.json({
      success: true,
      deckleId,
      // The produced MaterialStock doc's own _id -- the mobile app's Deckle
      // print button needs this for GET /deckle/:stockId/prn (deckleId alone
      // is the human-readable rollId, not a Mongo id).
      deckleStockId: production.rowMeta?.[0]?.stockId || null,
      meters: production.meters,
      location: deckleLocation,
      productCode: production.rowMeta?.[0]?.productCode || "",
      sourceReels: production.rowMeta?.[0]?.sourceReels || [],
    });
  } catch (err) {
    console.error("OPERATOR API INSTANT DECKLE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to move this Deckle to Semi Finished Stock." });
  }
});

router.post("/jobcard/material/set-remaining", requireOperatorApiAuth, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, stockId, remainingKg, reason } = req.body || {};
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
    const cleanReason = String(reason || "").trim().slice(0, 300);
    if (cleanReason.length < 3) {
      return res.status(400).json({ success: false, message: "Give a reason for taking this reel off the job." });
    }

    const pendingDoc = await PendingProduction.findById(pendingId).select("allottedLayers itemId operatorId").lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }
    if (String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const eligible = await getEligibleRawMaterials({ labelStock: pendingDoc.itemId, allottedLayers: pendingDoc.allottedLayers });
    if (!eligible.validStockIds?.[pool]?.has(String(stockId))) {
      return res.status(400).json({ success: false, message: "That reel doesn't match this order's recipe." });
    }

    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(stockId)}`);
    if (wip) {
      return res.status(409).json({ success: false, code: "wip", lotNo: wip.lotNo, machineName: wip.machineName });
    }

    const createdBy = req.authUser.empName;
    const result = await consumePoolUsage({ pool, rows: [{ stockId, remainingKg: remaining }], jobCardId: "", createdBy });
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
      reason: cleanReason,
      swappedAt: new Date(),
      swappedBy: createdBy,
    };
    await PendingProduction.updateOne({ _id: pendingId }, { $push: { materialSwapLog: swapEntry } });

    res.json({ success: true, swap: swapEntry });
  } catch (err) {
    console.error("OPERATOR API MATERIAL SET-REMAINING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update stock." });
  }
});

router.post("/jobcard", requireOperatorApiAuth, createLimiter, async (req, res) => {
  const body = req.body || {};

  if (mongoose.isValidObjectId(body.pendingId)) {
    const pendingDoc = await PendingProduction.findById(body.pendingId).select("operatorId").lean();
    if (!pendingDoc || String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  try {
    const result = await saveMachineJobCard({ body, actorName: req.authUser.empName });
    if (result.status === "duplicate") {
      return res.json({ status: "duplicate", pendingId: result.pendingId });
    }
    if (result.status === "gate-failed" || result.status === "wip-clash") {
      return res.status(409).json({ status: result.status, message: result.message });
    }
    return res.json({
      status: "ok",
      jobCardId: result.jobCardId,
      pendingId: result.pendingId,
      message: result.message,
      consumption: result.consumption,
      facestockConsumption: result.facestockConsumption,
      adhesiveConsumption: result.adhesiveConsumption,
      releaseConsumption: result.releaseConsumption,
      deckleProduction: result.deckleProduction,
      productionProgress: result.productionProgress,
    });
  } catch (err) {
    console.error("OPERATOR API JOB CARD ERROR:", err);
    res.status(500).json({ error: "Failed to save production entry" });
  }
});

/*
 * Roll/Deckle label printing -- TSPL builders exist server-side
 * (utils/*RollLabel.js) but were wired to no HTTP route in this codebase
 * (browser Print instead, see views/stock/*RollLabel.ejs); these are the
 * first routes to actually serve them, following FAIRTECH-ERP's
 * GET /rolls/:stockId/prn pattern. Scoped deliberately: only serve TSPL for
 * a reel actually tied to one of *this operator's own* jobs.
 */
const PRN_BUILDERS = {
  facestock: buildFacestockRollLabelPrn,
  adhesive: buildAdhesiveRollLabelPrn,
  release: buildReleaseLinerRollLabelPrn,
};
const LAYER_KEYS_BY_POOL = {
  facestock: ["facestock", "facestock2"],
  adhesive: ["adhesive", "adhesive2"],
  release: ["releaseLiner", "releaseLiner2"],
};

async function operatorOwnsPoolReel({ empObjId, pool, stockId }) {
  if (!empObjId || !mongoose.isValidObjectId(stockId)) return false;
  const keys = LAYER_KEYS_BY_POOL[pool] || [];
  const sid = String(stockId);
  const jobs = await PendingProduction.find({ operatorId: empObjId })
    .select("allottedLayers liveMaterialInUse")
    .lean();
  return jobs.some((job) => {
    if ((job.liveMaterialInUse?.[pool] || []).some((id) => String(id) === sid)) return true;
    return keys.some((k) => pickStockIds(job.allottedLayers?.[k]).includes(sid));
  });
}

async function servePoolPrn(req, res, pool) {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return res.status(400).json({ error: "Invalid roll id" });

    const owns = await operatorOwnsPoolReel({ empObjId: req.authUser.empObjId, pool, stockId });
    if (!owns) return res.status(403).json({ error: "Forbidden" });

    const select = pool === "adhesive" ? "rollId vendorName vendorSkuCode invoiceNo reelMtrs" : "rollId vendorName vendorSkuCode invoiceNo reelMtrs size";
    const reel = await POOL_MODELS[pool].Model.findById(stockId).select(select).lean();
    if (!reel) return res.status(404).json({ error: "Roll not found" });

    const tspl = PRN_BUILDERS[pool]({
      vendorName: reel.vendorName,
      vendorSkuCode: reel.vendorSkuCode,
      invoiceNo: reel.invoiceNo,
      reelMtrs: reel.reelMtrs,
      size: reel.size,
      rollId: reel.rollId,
    });
    res.json({ tspl });
  } catch (err) {
    console.error(`OPERATOR API ${pool.toUpperCase()} PRN ERROR:`, err);
    res.status(500).json({ error: "Failed to build label" });
  }
}

router.get("/facestock/:stockId/prn", requireOperatorApiAuth, (req, res) => servePoolPrn(req, res, "facestock"));
router.get("/adhesive/:stockId/prn", requireOperatorApiAuth, (req, res) => servePoolPrn(req, res, "adhesive"));
router.get("/release/:stockId/prn", requireOperatorApiAuth, (req, res) => servePoolPrn(req, res, "release"));

router.get("/deckle/:stockId/prn", requireOperatorApiAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return res.status(400).json({ error: "Invalid roll id" });

    const reel = await MaterialStock.findById(stockId)
      .select("rollId reelMtrs size joints lotNo material producedFor")
      .populate({ path: "material", select: "productCode skuCode" })
      .lean();
    if (!reel) return res.status(404).json({ error: "Roll not found" });

    // A Deckle only carries producedFor when this app laminated it (see
    // models/inventory/materialStock.js's own comment on that field) --
    // exactly the ones an operator's own job card produces.
    const owningJob = reel.producedFor
      ? await PendingProduction.findOne({ _id: reel.producedFor, operatorId: req.authUser.empObjId }).select("_id").lean()
      : null;
    if (!owningJob) return res.status(403).json({ error: "Forbidden" });

    const tspl = buildMaterialStockRollLabelPrn({
      rollId: reel.rollId,
      reelMtrs: reel.reelMtrs,
      size: reel.size,
      joints: reel.joints,
      lotNo: reel.lotNo,
      prodCode: reel.material?.productCode || reel.material?.skuCode,
    });
    res.json({ tspl });
  } catch (err) {
    console.error("OPERATOR API DECKLE PRN ERROR:", err);
    res.status(500).json({ error: "Failed to build label" });
  }
});

/*
 * Maintenance -- the JSON mirror of the operator's server-rendered Maintenance
 * tab (routes/system/maintenance.js). Both reuse the same helpers there, so
 * the web page and the app create and read identical tickets; the only
 * difference is these return JSON instead of rendering EJS and are
 * bearer-authed.
 */

router.get("/maintenance", requireOperatorApiAuth, async (req, res) => {
  const authUser = req.authUser;
  const operatorObjId = authUser?.empObjId;

  const docs =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.find({ raisedById: operatorObjId }).sort({ createdAt: -1 }).lean()
      : [];

  const { machineId, machineName, locationName } = await resolveOperatorMachine(authUser);
  const machines = await listMachinesAtLocation(locationName);

  res.json({
    machineName,
    locationName,
    machines: machines.map((m) => ({ _id: String(m._id), machineName: m.machineName })),
    defaultMachineId: machineId ? String(machineId) : "",
    requests: docs.map(toMaintenanceRow),
  });
});

router.post("/maintenance", requireOperatorApiAuth, createLimiter, maintenanceUpload, async (req, res) => {
  try {
    const { ticket } = await createOperatorTicket({
      authUser: req.authUser,
      description: req.body.description,
      requestedMachineId: req.body.machineId,
      files: req.files,
    });
    const row = toMaintenanceRow(ticket);
    res.json({ success: true, ticketNo: row.ticketNo, ticket: row });
  } catch (err) {
    if (!(err instanceof MaintenanceInputError)) console.error("OPERATOR API MAINTENANCE CREATE ERROR:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message || "Could not report the issue." });
  }
});

const serveApiAttachment = (thumb) => (req, res) =>
  serveMaintenanceAsset(res, {
    id: req.params.id,
    index: req.params.index,
    thumb,
    viewer: { role: req.authUser?.role, empObjId: req.authUser?.empObjId },
  });

router.get("/maintenance/media/:id/:index", requireOperatorApiMediaAuth, serveApiAttachment(false));
router.get("/maintenance/media/:id/:index/thumb", requireOperatorApiMediaAuth, serveApiAttachment(true));

export default router;
