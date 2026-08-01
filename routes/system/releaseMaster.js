import express from "express";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import Vendor from "../../models/users/vendor.js";
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

async function buildPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const payload = {
    vendorId,
    type: String(body.type || "").trim(),
    make: String(body.make || "").trim(),
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    gsm: numOrUndef(body.gsm),
  };

  if (vendorId) {
    const vendor = await Vendor.findById(vendorId).select("vendorName").lean();
    payload.vendorName = vendor?.vendorName || "";
  }

  return payload;
}

function validatePayload(payload) {
  if (!payload.vendorId || !payload.vendorName) return "Vendor Name is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/release", requireReleaseMaster, async (req, res) => {
  const [releases, previewSkuId, vendors] = await Promise.all([
    ReleaseMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("releaseMasterSkuId", "REL"),
    Vendor.find({ commodities: "RELEASE PAPER" }, { vendorName: 1 }).sort({ vendorName: 1 }).lean(),
  ]);
  res.render("inventory/masters/releaseMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Master",
    releases,
    previewSkuId,
    vendors,
    notification: req.flash("notification"),
  });
});

router.post("/form/release", requireAuth, requireReleaseMaster, createLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const skuId = await generateId("releaseMasterSkuId", "REL");
    await ReleaseMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created release master "${skuId}" (${payload.vendorName})`;
    req.flash("notification", "Release master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/release" });
  } catch (err) {
    console.error("RELEASE MASTER CREATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to create release master." });
  }
});

router.put("/api/release/:id", requireAuth, requireReleaseMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const updated = await ReleaseMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }

    res.locals.auditDescription = `Updated release master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update release master." });
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
