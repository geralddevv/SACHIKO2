import express from "express";
import mongoose from "mongoose";
import MaterialStock from "../../models/inventory/materialStock.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  buildLabelFields,
  buildQrPayload,
  labelLayoutMm,
  rollLabelModuleCount,
  rollLabelQrDataUrl,
} from "../../utils/materialStockRollLabel.js";

const router = express.Router();

// Semi Finished Goods = Deckle stock (MaterialStock). Deckles are created two
// ways: Assign Production's legacy "Produce New Deckle" section
// (routes/fairdesk_route.js POST /labels/production/assign/:id ->
// produceDeckle() in utils/labelStockProduction.js), and -- the normal path
// now -- one per Production Log row on the machine job card, once the job
// finishes (routes/system/machine.js's produceDecklesFromLog, called from
// POST /machine/jobcard/form). This page is a list/edit/delete view onto
// that same MaterialStock data either way, not a third way to create one.
router.get("/", async (req, res) => {
  const [locations, stock] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    MaterialStock.find()
      .populate({ path: "material", select: "productCode skuCode family" })
      .populate({ path: "producedFor", select: "paperSize materialSwapLog" })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  // The job card that produced each Deckle -- used to show its base Product
  // Code (so an "-A"/"-B" variant reads as a variant) and, for older Deckles
  // written before MaterialStock.sourceReels existed, the reel list off the
  // production-log row itself.
  const deckleIds = stock.map((s) => s.rollId).filter(Boolean);
  const jobCards = deckleIds.length
    ? await MachineJobCard.find({ "productionLog.deckleId": { $in: deckleIds } })
        .select("productCode productionLog facestockUsage adhesiveUsage releaseUsage")
        .lean()
    : [];
  const jobCardRowByDeckle = new Map();
  for (const jc of jobCards) {
    for (const row of jc.productionLog || []) {
      if (row?.deckleId) jobCardRowByDeckle.set(row.deckleId, { baseProductCode: jc.productCode || "", row, jobCard: jc });
    }
  }

  // Kg consumed from one raw reel, resolved for a given Deckle. Every raw
  // reel in this system is weighed, not measured -- FacestockStock /
  // AdhesiveStock / ReleaseLinerStock `reelMtrs` is really kilograms, and so
  // is the usage snapshot (`facestockUsage.mtrsUsed` / `releaseUsage.mtrsUsed`
  // are legacy names carrying kg, `adhesiveUsage.kgUsed` is named honestly).
  // A reel swapped out mid-run is reconciled live onto the order's
  // materialSwapLog (usedKg); a reel still mounted at job end is reconciled in
  // the Job Card's end-of-job Material Used dialog into the *Usage arrays --
  // the two are disjoint, so their union covers every reel a Deckle used.
  //
  // Both figures are per reel per Job Card, not per Deckle -- when one card
  // ran several Deckles off the same reel, split that reel's kg across those
  // Deckles in proportion to each one's produced metres (same reel => same
  // width + gsm => kg is linear in metres).
  const norm = (v) => String(v || "").trim().toUpperCase();
  const reelMatches = (entry, sid, rid) =>
    (sid && String(entry.stockId) === sid) || (rid && norm(entry.rollId) === rid);

  const kgUsedFor = (deckle, reel) => {
    const sid = reel.stockId ? String(reel.stockId) : "";
    const rid = norm(reel.rollId);
    const entry = jobCardRowByDeckle.get(deckle.rollId);
    const jc = entry?.jobCard;

    const poolArr = {
      facestock: jc?.facestockUsage,
      adhesive: jc?.adhesiveUsage,
      release: jc?.releaseUsage,
    }[reel.pool];
    let reelKg = null;
    const fromUsage = (Array.isArray(poolArr) ? poolArr : []).find((u) => reelMatches(u, sid, rid));
    if (fromUsage) {
      const v = fromUsage.kgUsed != null ? fromUsage.kgUsed : fromUsage.mtrsUsed;
      if (Number.isFinite(Number(v))) reelKg = Number(v);
    }
    if (reelKg == null) {
      const swaps = Array.isArray(deckle.producedFor?.materialSwapLog) ? deckle.producedFor.materialSwapLog : [];
      const fromSwap = swaps.find((s) => s.pool === reel.pool && reelMatches(s, sid, rid));
      if (fromSwap && Number.isFinite(Number(fromSwap.usedKg))) reelKg = Number(fromSwap.usedKg);
    }
    if (reelKg == null) return null;

    // Pro-rate across every Deckle row on this card that drew on this reel.
    const rows = Array.isArray(jc?.productionLog) ? jc.productionLog : [];
    const poolRollField = { facestock: "fsRollId", adhesive: "adRollId", release: "rlRollId" }[reel.pool];
    const sharing = rows.filter((row) => {
      const list = Array.isArray(row.materialsUsed) ? row.materialsUsed : [];
      if (list.length) {
        return list.some((m) => (m.pool || reel.pool) === reel.pool && reelMatches(m, sid, rid));
      }
      return rid && poolRollField && norm(row[poolRollField]).includes(rid);
    });
    if (sharing.length <= 1) return Math.round(reelKg * 100) / 100;
    const totalMtrs = sharing.reduce((n, row) => n + (Number(row.meters) || 0), 0);
    const thisMtrs = Number(entry?.row?.meters) || 0;
    if (!(totalMtrs > 0) || !(thisMtrs > 0)) return Math.round((reelKg / sharing.length) * 100) / 100;
    return Math.round(reelKg * (thisMtrs / totalMtrs) * 100) / 100;
  };

  // The note the operator typed when taking this reel off the job mid-run --
  // mandatory in the "How much is left?" dialog on the Job Card, stored on the
  // order's materialSwapLog. Only a swapped-out reel has one.
  const swapRemarkFor = (deckle, reel) => {
    const sid = reel.stockId ? String(reel.stockId) : "";
    const rid = norm(reel.rollId);
    const swaps = Array.isArray(deckle.producedFor?.materialSwapLog) ? deckle.producedFor.materialSwapLog : [];
    const hit = swaps.find((s) => s.pool === reel.pool && reelMatches(s, sid, rid));
    return hit?.reason ? String(hit.reason).trim() : "";
  };

  const baseOf = (code) => {
    const m = /^(.*[^-])-[A-Z]+$/.exec(String(code || ""));
    return m ? m[1] : "";
  };

  // Resolve each Deckle's raw-material reels (Deckle's own sourceReels first,
  // then the job-card row's materialsUsed, then the row's single-reel-per-pool
  // fields) up front, so we can look every reel's own spec up in one batch.
  const reelListFor = (s) => {
    const jc = jobCardRowByDeckle.get(s.rollId);
    if (Array.isArray(s.sourceReels) && s.sourceReels.length) return s.sourceReels;
    if (Array.isArray(jc?.row?.materialsUsed) && jc.row.materialsUsed.length) return jc.row.materialsUsed;
    if (jc?.row) {
      return [
        jc.row.fsRollId && { pool: "facestock", rollId: jc.row.fsRollId },
        jc.row.adRollId && { pool: "adhesive", rollId: jc.row.adRollId },
        jc.row.rlRollId && { pool: "release", rollId: jc.row.rlRollId },
      ].filter(Boolean);
    }
    return [];
  };

  const reelListByDeckle = new Map(stock.map((s) => [String(s._id), reelListFor(s)]));

  // One batched lookup per pool for the reel-level spec (vendor / type / size /
  // GSM / metres), keyed by rollId -- these raw reels stay in their collection
  // at quantity 0 after being consumed, so the row is still there to read.
  const rollIdsIn = (pool) => [
    ...new Set(
      [...reelListByDeckle.values()]
        .flat()
        .filter((r) => (r.pool || "") === pool)
        .map((r) => String(r.rollId || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const [fsReels, adReels, rlReels] = await Promise.all([
    FacestockStock.find({ rollId: { $in: rollIdsIn("facestock") } })
      .select("rollId type size gsm micron").lean(),
    AdhesiveStock.find({ rollId: { $in: rollIdsIn("adhesive") } })
      .select("rollId type gsm").lean(),
    ReleaseLinerStock.find({ rollId: { $in: rollIdsIn("release") } })
      .select("rollId type color size gsm").lean(),
  ]);

  const specByRoll = new Map();
  const compact = (parts) => parts.filter((p) => p != null && p !== "").join(" · ");
  for (const r of fsReels) {
    specByRoll.set(r.rollId, {
      spec: compact([r.type, r.gsm ? `${r.gsm} GSM` : "", r.micron ? `${r.micron} MIC` : "", r.size ? `${r.size} mm` : ""]),
    });
  }
  for (const r of adReels) {
    specByRoll.set(r.rollId, {
      spec: compact([r.type, r.gsm ? `${r.gsm} GSM` : ""]),
    });
  }
  for (const r of rlReels) {
    specByRoll.set(r.rollId, {
      spec: compact([r.type, r.color, r.gsm ? `${r.gsm} GSM` : "", r.size ? `${r.size} mm` : ""]),
    });
  }

  res.render("stock/semiFinishedStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Semi Finished Goods Stock",
    // Passed through rather than hardcoded in the view's CSS, so the label
    // preview frame (see the Print dialog) can never quietly disagree with
    // the label rendered inside it -- both come from
    // utils/materialStockRollLabel.js.
    labelSizeMm: { width: LABEL_WIDTH_MM, height: LABEL_HEIGHT_MM },
    locations,
    stock: stock.map((s) => {
      const productCode = s.material?.productCode || s.material?.skuCode || "";
      const jc = jobCardRowByDeckle.get(s.rollId);
      const sourceReels = reelListByDeckle.get(String(s._id)) || [];
      const baseProductCode = jc?.baseProductCode || baseOf(productCode);
      return {
        _id: String(s._id),
        rollId: s.rollId,
        productCode,
        baseProductCode,
        isVariant: Boolean(baseProductCode && productCode && baseProductCode !== productCode),
        sourceReels: (sourceReels || []).map((r) => {
          const rid = String(r.rollId || "").trim().toUpperCase();
          const extra = specByRoll.get(rid) || {};
          return {
            pool: r.pool || "",
            rollId: r.rollId || "",
            spec: extra.spec || "",
            kgUsed: kgUsedFor(s, r),
            remark: swapRemarkFor(s, r),
          };
        }),
        family: s.material?.family || "",
        // Existing Deckles can fall back to the production order while all new
        // production saves the size directly on MaterialStock.
        size: s.size || s.producedFor?.paperSize || "",
        joints: s.joints || "",
        lotNo: s.lotNo || "",
        location: s.location,
        reelMtrs: s.reelMtrs,
        rate: s.rate,
        value: Number.isFinite(Number(s.reelMtrs)) && Number.isFinite(Number(s.rate))
          ? Number(s.reelMtrs) * Number(s.rate)
          : null,
        remarks: s.remarks || "",
        createdAt: s.createdAt,
      };
    }),
    notification: req.flash("notification"),
  });
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const location = String(req.body.location || "").trim();
    const rate = req.body.rate === undefined || req.body.rate === "" ? undefined : Number(req.body.rate);
    const remarks = String(req.body.remarks || "").trim();

    if (!location) return res.status(400).json({ success: false, message: "Location is required." });

    const locationExists = await Location.exists({ locationName: location });
    if (!locationExists) return res.status(400).json({ success: false, message: "Invalid location." });

    const updated = await MaterialStock.findByIdAndUpdate(
      req.params.id,
      { location, rate, remarks: remarks || undefined },
      { new: true, runValidators: true },
    );
    if (!updated) return res.status(404).json({ success: false, message: "Deckle reel not found." });

    res.locals.auditDescription = `Updated semi finished goods (Deckle) reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("SEMI FINISHED STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update Deckle reel." });
  }
});

// Failures here are read inside the Print dialog's iframe (see
// openLabelDialog in views/stock/semiFinishedStock.ejs), which fetches this
// route and writes the response in as srcdoc rather than navigating a frame
// to it -- see routes/stock/facestockStock.js's own sendLabelError for why
// (an expired session's redirect would otherwise just kill the frame).
function sendLabelError(res, status, message) {
  res.status(status).type("html").send(
    `<!DOCTYPE html><meta charset="utf-8">`
    + `<div style="font:600 13px/1.5 Arial,Helvetica,sans-serif;color:#b91c1c;`
    + `display:flex;align-items:center;justify-content:center;height:100vh;`
    + `margin:0;text-align:center;padding:0 12px;">${message}</div>`,
  );
}

// The Deckle's printed sticker, as a page the browser prints -- see
// routes/stock/facestockStock.js's own /label/:stockId, which this mirrors.
// The SOFT.prn layout is used exactly as-is: WIDTH receives the Deckle's
// finished size, JOINTS receives the production-log status when recorded,
// and FACE/ADHESIVE/RELEASE intentionally remain "-".
router.get("/label/:stockId", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return sendLabelError(res, 404, "Deckle reel not found.");

    const reel = await MaterialStock.findById(stockId)
      .select("rollId reelMtrs size joints lotNo producedFor")
      .populate({
        path: "material",
        select: "productCode skuCode",
      })
      .populate({ path: "producedFor", select: "lotNo" })
      .lean();
    if (!reel) return sendLabelError(res, 404, "Deckle reel not found.");

    // Deckles created before MaterialStock.joints was introduced still have
    // their status on the immutable production log. Read it as a fallback so
    // their label is just as complete as a newly produced Deckle's label.
    let joints = reel.joints;
    let lotNo = reel.lotNo || reel.producedFor?.lotNo;
    if (!joints || !lotNo) {
      const jobCard = await MachineJobCard.findOne({ "productionLog.deckleId": reel.rollId })
        .select("lotNo productionLog")
        .lean();
      const logRow = jobCard?.productionLog?.find((row) => row.deckleId === reel.rollId);
      if (!joints) {
        joints = [...new Set([logRow?.face?.joint, logRow?.release?.joint]
          .map((value) => String(value || "").trim())
          .filter(Boolean))]
          .join(" / ") || undefined;
      }
      lotNo ||= jobCard?.lotNo;
    }

    const labelInput = {
      rollId: reel.rollId,
      reelMtrs: reel.reelMtrs,
      size: reel.size,
      joints,
      lotNo,
      prodCode: reel.material?.productCode || reel.material?.skuCode,
    };
    // The QR's module count depends on the whole payload's length, so the
    // box can only be sized once the payload exists -- hence building the
    // payload here rather than letting the view ask for a data URL.
    const qrPayload = buildQrPayload(labelInput);

    res.render("stock/materialStockRollLabel.ejs", {
      rollId: reel.rollId,
      fields: buildLabelFields(labelInput),
      // Named `mm`, not `layout` -- `layout` is ejs-mate's own helper and a
      // local of that name breaks rendering.
      mm: labelLayoutMm(rollLabelModuleCount(qrPayload)),
      qrDataUrl: await rollLabelQrDataUrl(qrPayload),
    });
  } catch (err) {
    console.error("SEMI FINISHED STOCK LABEL ERROR:", err);
    sendLabelError(res, 500, "Failed to build the label.");
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await MaterialStock.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Deckle reel not found." });

    res.locals.auditDescription = `Deleted semi finished goods (Deckle) reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("SEMI FINISHED STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete Deckle reel." });
  }
});

export default router;
