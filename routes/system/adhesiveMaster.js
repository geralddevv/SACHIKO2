import express from "express";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
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

const requireAdhesiveMaster = requireRole(["proprietor", "admin", "hod"]);

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
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

router.get("/form/adhesive", requireAdhesiveMaster, async (req, res) => {
  const [adhesives, previewSkuId] = await Promise.all([
    AdhesiveMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("adhesiveMasterSkuId", "ADH"),
  ]);
  res.render("inventory/masters/adhesiveMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Adhesive Master",
    adhesives,
    previewSkuId,
    notification: req.flash("notification"),
  });
});

router.post("/form/adhesive", requireAuth, requireAdhesiveMaster, createLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await AdhesiveMaster.exists({ skuCode: payload.skuCode });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const skuId = await generateId("adhesiveMasterSkuId", "ADH");
    await AdhesiveMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created adhesive master "${skuId}" (${payload.skuCode})`;
    req.flash("notification", "Adhesive master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/adhesive" });
  } catch (err) {
    console.error("ADHESIVE MASTER CREATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to create adhesive master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/api/adhesive/:id", requireAuth, requireAdhesiveMaster, updateLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await AdhesiveMaster.exists({ skuCode: payload.skuCode, _id: { $ne: req.params.id } });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const updated = await AdhesiveMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Adhesive master not found." });
    }

    res.locals.auditDescription = `Updated adhesive master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE MASTER UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to update adhesive master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/adhesive/:id", requireAuth, requireAdhesiveMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await AdhesiveMaster.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Adhesive master not found." });
    }
    res.locals.auditDescription = `Deleted adhesive master "${existing.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete adhesive master." });
  }
});

export default router;
