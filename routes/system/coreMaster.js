import express from "express";
import CoreMaster from "../../models/inventory/coreMaster.js";
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

const requireCoreMaster = requireRole(["proprietor", "admin", "hod"]);

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
    skuCode: String(body.skuCode || "").trim(),
    type: String(body.type || "").trim(),
    size: numOrUndef(body.size),
    mtrs: numOrUndef(body.mtrs),
  };
}

function validatePayload(payload) {
  if (!payload.skuCode) return "SKU Code is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/core", requireCoreMaster, async (req, res) => {
  const [cores, previewSkuId] = await Promise.all([
    CoreMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("coreMasterSkuId", "COR"),
  ]);
  res.render("inventory/masters/coreMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Core Master",
    cores,
    previewSkuId,
    notification: req.flash("notification"),
  });
});

router.post("/form/core", requireAuth, requireCoreMaster, createLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await CoreMaster.exists({ skuCode: payload.skuCode });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const skuId = await generateId("coreMasterSkuId", "COR");
    await CoreMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created core master "${skuId}" (${payload.skuCode})`;
    req.flash("notification", "Core master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/core" });
  } catch (err) {
    console.error("CORE MASTER CREATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to create core master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/api/core/:id", requireAuth, requireCoreMaster, updateLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await CoreMaster.exists({ skuCode: payload.skuCode, _id: { $ne: req.params.id } });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const updated = await CoreMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Core master not found." });
    }

    res.locals.auditDescription = `Updated core master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("CORE MASTER UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to update core master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/core/:id", requireAuth, requireCoreMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await CoreMaster.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Core master not found." });
    }
    res.locals.auditDescription = `Deleted core master "${existing.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("CORE MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete core master." });
  }
});

export default router;
