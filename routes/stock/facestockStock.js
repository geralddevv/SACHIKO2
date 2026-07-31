import express from "express";
import FacestockStock from "../../models/inventory/facestockStock.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollId } from "../../utils/materialRollId.js";

const router = express.Router();
const ROLL_ID_PREFIX = "FACESTOCK";

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
    family: String(body.family || "").trim(),
    type: String(body.type || "").trim(),
    gsm: numOrUndef(body.gsm),
    micron: numOrUndef(body.micron),
    location: String(body.location || "").trim(),
    reelMtrs: Number(body.reelMtrs),
    rate: numOrUndef(body.rate),
    vendorRollId: String(body.vendorRollId || "").trim(),
    invoiceNo: String(body.invoiceNo || "").trim(),
    remarks: String(body.remarks || "").trim(),
  };
}

function validatePayload(payload) {
  if (!payload.type) return "Type is required.";
  if (!payload.location) return "Location is required.";
  if (!payload.reelMtrs || payload.reelMtrs <= 0) return "Mtrs is required.";
  return null;
}

router.get("/", async (req, res) => {
  const [locations, stock, previewRollId] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    FacestockStock.find().sort({ createdAt: -1 }).lean(),
    previewMaterialRollId(ROLL_ID_PREFIX),
  ]);
  res.render("stock/facestockStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Facestock Stock",
    locations,
    stock,
    previewRollId,
    notification: req.flash("notification"),
  });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const locationExists = await Location.exists({ locationName: payload.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, FacestockStock);
    await FacestockStock.create({ ...payload, rollId });

    res.locals.auditDescription = `Added facestock stock reel "${rollId}" (${payload.type}) at "${payload.location}"`;
    req.flash("notification", "Facestock stock added successfully!");
    res.json({ success: true, redirect: "/sachiko/facestockstock" });
  } catch (err) {
    console.error("FACESTOCK STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add facestock stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const locationExists = await Location.exists({ locationName: payload.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const updated = await FacestockStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Facestock stock reel not found." });
    }

    res.locals.auditDescription = `Updated facestock stock reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update facestock stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await FacestockStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Facestock stock reel not found." });
    }
    res.locals.auditDescription = `Deleted facestock stock reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete facestock stock." });
  }
});

export default router;
