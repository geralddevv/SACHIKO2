import express from "express";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollId } from "../../utils/materialRollId.js";

const router = express.Router();
const ROLL_ID_PREFIX = "RELEASE";

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
    type: String(body.type || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    gsm: numOrUndef(body.gsm),
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
    ReleaseLinerStock.find().sort({ createdAt: -1 }).lean(),
    previewMaterialRollId(ROLL_ID_PREFIX),
  ]);
  res.render("stock/releaseLinerStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Liner Stock",
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

    const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, ReleaseLinerStock);
    await ReleaseLinerStock.create({ ...payload, rollId });

    res.locals.auditDescription = `Added release liner stock reel "${rollId}" (${payload.type}) at "${payload.location}"`;
    req.flash("notification", "Release liner stock added successfully!");
    res.json({ success: true, redirect: "/sachiko/releaselinerstock" });
  } catch (err) {
    console.error("RELEASE LINER STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add release liner stock.";
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

    const updated = await ReleaseLinerStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }

    res.locals.auditDescription = `Updated release liner stock reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE LINER STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update release liner stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await ReleaseLinerStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }
    res.locals.auditDescription = `Deleted release liner stock reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE LINER STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete release liner stock." });
  }
});

export default router;
