import express from "express";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
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

const requireReleaseMaster = requireRole(["proprietor", "admin", "hod"]);

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function buildPayload(body) {
  return {
    skuCode: String(body.skuCode || "").trim(),
    type: String(body.type || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    gsm: numOrUndef(body.gsm),
    mtrs: numOrUndef(body.mtrs),
  };
}

function validatePayload(payload) {
  if (!payload.skuCode) return "SKU Code is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/release", requireReleaseMaster, async (req, res) => {
  const [releases, previewSkuId] = await Promise.all([
    ReleaseMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("releaseMasterSkuId", "REL"),
  ]);
  res.render("inventory/masters/releaseMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Master",
    releases,
    previewSkuId,
    notification: req.flash("notification"),
  });
});

router.post("/form/release", requireAuth, requireReleaseMaster, createLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await ReleaseMaster.exists({ skuCode: payload.skuCode });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const skuId = await generateId("releaseMasterSkuId", "REL");
    await ReleaseMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created release master "${skuId}" (${payload.skuCode})`;
    req.flash("notification", "Release master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/release" });
  } catch (err) {
    console.error("RELEASE MASTER CREATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to create release master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/api/release/:id", requireAuth, requireReleaseMaster, updateLimiter, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateSkuCode = await ReleaseMaster.exists({ skuCode: payload.skuCode, _id: { $ne: req.params.id } });
    if (duplicateSkuCode) {
      return res.status(400).json({ success: false, message: "This SKU Code already exists." });
    }

    const updated = await ReleaseMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }

    res.locals.auditDescription = `Updated release master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "This SKU Code already exists." : "Failed to update release master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/release/:id", requireAuth, requireReleaseMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await ReleaseMaster.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }
    res.locals.auditDescription = `Deleted release master "${existing.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete release master." });
  }
});

export default router;
