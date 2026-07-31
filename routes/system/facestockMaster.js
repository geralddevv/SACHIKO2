import express from "express";
import FacestockMaster from "../../models/inventory/facestockMaster.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Same "SP | <CODE> | 000001" id scheme used for Machine/Label Stock/Job Card
// ids elsewhere (see routes/system/machine.js, routes/sachiko/sachiko_route.js).
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

const requireFacestockMaster = requireRole(["proprietor", "admin", "hod"]);

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
    family: String(body.family || "").trim(),
    skuCode: String(body.skuCode || "").trim(),
    type: String(body.type || "").trim(),
    gsm: numOrUndef(body.gsm),
    mtrs: numOrUndef(body.mtrs),
  };
}

function validatePayload(payload) {
  if (!payload.skuCode) return "SKU Code is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/facestock", requireFacestockMaster, async (req, res) => {
  const [facestocks, previewSkuId] = await Promise.all([
    FacestockMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("facestockMasterSkuId", "FCS"),
  ]);
  res.render("inventory/masters/facestockMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Facestock Master",
    facestocks,
    previewSkuId,
    notification: req.flash("notification"),
  });
});

router.post("/form/facestock", requireAuth, requireFacestockMaster, createLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await FacestockMaster.exists({ skuCode: payload.skuCode });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const skuId = await generateId("facestockMasterSkuId", "FCS");
    await FacestockMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created facestock master "${skuId}" (${payload.skuCode})`;
    req.flash("notification", "Facestock master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/facestock" });
  } catch (err) {
    console.error("FACESTOCK MASTER CREATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to create facestock master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/api/facestock/:id", requireAuth, requireFacestockMaster, updateLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await FacestockMaster.exists({ skuCode: payload.skuCode, _id: { $ne: req.params.id } });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const updated = await FacestockMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Facestock master not found." });
    }

    res.locals.auditDescription = `Updated facestock master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK MASTER UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to update facestock master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/facestock/:id", requireAuth, requireFacestockMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await FacestockMaster.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Facestock master not found." });
    }
    res.locals.auditDescription = `Deleted facestock master "${existing.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete facestock master." });
  }
});

export default router;
