import express from "express";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
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

const requireAdhesiveMaster = requireRole(["proprietor", "admin", "hod"]);

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
    shelfLife: String(body.shelfLife || "").trim(),
    viscosity: numOrUndef(body.viscosity),
    cohesion: numOrUndef(body.cohesion),
    shear: numOrUndef(body.shear),
    density: numOrUndef(body.density),
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
  if (!payload.vendorSkuCode) return "Vendor SKU Code is required.";
  if (!payload.shelfLife) return "Shelf Life is required.";
  return null;
}

router.get("/form/adhesive", requireAdhesiveMaster, async (req, res) => {
  const [adhesives, previewSkuId, vendors] = await Promise.all([
    AdhesiveMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("adhesiveMasterSkuId", "ADH"),
    Vendor.find({ commodities: "ADHESIVE" }, { vendorName: 1 }).sort({ vendorName: 1 }).lean(),
  ]);
  res.render("inventory/masters/adhesiveMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Adhesive Master",
    adhesives,
    previewSkuId,
    vendors,
    notification: req.flash("notification"),
  });
});

router.post("/form/adhesive", requireAuth, requireAdhesiveMaster, createLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateVendorSkuCode = await AdhesiveMaster.exists({ vendorId: payload.vendorId, vendorSkuCode: payload.vendorSkuCode });
    if (duplicateVendorSkuCode) {
      return res.status(400).json({ success: false, message: "This Vendor SKU Code already exists for this vendor." });
    }

    const skuId = await generateId("adhesiveMasterSkuId", "ADH");
    await AdhesiveMaster.create({ ...payload, skuId });

    res.locals.auditDescription = `Created adhesive master "${skuId}" (${payload.vendorSkuCode})`;
    req.flash("notification", "Adhesive master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/adhesive" });
  } catch (err) {
    console.error("ADHESIVE MASTER CREATE ERROR:", err);
    const msg = err.code === 11000 ? "This Vendor SKU Code already exists for this vendor." : "Failed to create adhesive master.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/api/adhesive/:id", requireAuth, requireAdhesiveMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const duplicateVendorSkuCode = await AdhesiveMaster.exists({
      vendorId: payload.vendorId,
      vendorSkuCode: payload.vendorSkuCode,
      _id: { $ne: req.params.id },
    });
    if (duplicateVendorSkuCode) {
      return res.status(400).json({ success: false, message: "This Vendor SKU Code already exists for this vendor." });
    }

    const updated = await AdhesiveMaster.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Adhesive master not found." });
    }

    res.locals.auditDescription = `Updated adhesive master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE MASTER UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "This Vendor SKU Code already exists for this vendor." : "Failed to update adhesive master.";
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
