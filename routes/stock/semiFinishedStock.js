import express from "express";
import mongoose from "mongoose";
import MaterialStock from "../../models/inventory/materialStock.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
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
      .populate({ path: "producedFor", select: "paperSize" })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

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
    stock: stock.map((s) => ({
      _id: String(s._id),
      rollId: s.rollId,
      productCode: s.material?.productCode || s.material?.skuCode || "",
      family: s.material?.family || "",
      // Existing Deckles can fall back to the production order while all new
      // production saves the size directly on MaterialStock.
      size: s.size || s.producedFor?.paperSize || "",
      location: s.location,
      reelMtrs: s.reelMtrs,
      rate: s.rate,
      value: Number.isFinite(Number(s.reelMtrs)) && Number.isFinite(Number(s.rate))
        ? Number(s.reelMtrs) * Number(s.rate)
        : null,
      remarks: s.remarks || "",
      createdAt: s.createdAt,
    })),
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
