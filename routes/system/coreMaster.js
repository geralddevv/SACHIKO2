import express from "express";
import crypto from "crypto";
import CoreMaster from "../../models/inventory/coreMaster.js";
import Vendor from "../../models/users/vendor.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Same sha256 signature scheme used for Client/TapeSalesOrder/Label Stock
// Binding duplicate prevention (see routes/users/clients.js,
// routes/fairdesk_route.js, routes/sachiko/labelStockBinding.js) -- blocks
// create/edit only when every field matches an existing record exactly.
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildCoreSignature(payload) {
  return hashSignature(
    [
      String(payload.vendorId || ""),
      canonStr(payload.type),
      canonStr(payload.make),
      canonStr(payload.printType),
      String(Number(payload.thickness ?? "")),
      String(Number(payload.width ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_CORE_MESSAGE = "This core already exists (every field matches an existing record).";

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

async function buildPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const payload = {
    vendorId,
    type: String(body.type || "").trim(),
    make: String(body.make || "").trim(),
    printType: String(body.printType || "").trim(),
    thickness: numOrUndef(body.thickness),
    width: numOrUndef(body.width),
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
  if (!payload.printType) return "Print Type is required.";
  if (payload.thickness === undefined) return "Thickness is required.";
  if (payload.width === undefined) return "Width is required.";
  return null;
}

router.get("/form/core", requireCoreMaster, async (req, res) => {
  const [cores, previewSkuId, vendors] = await Promise.all([
    CoreMaster.find().sort({ createdAt: -1 }).lean(),
    previewId("coreMasterSkuId", "COR"),
    Vendor.find({ commodities: "CORE" }, { vendorName: 1 }).sort({ vendorName: 1 }).lean(),
  ]);
  res.render("inventory/masters/coreMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Core Master",
    cores,
    previewSkuId,
    vendors,
    notification: req.flash("notification"),
  });
});

router.post("/form/core", requireAuth, requireCoreMaster, createLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const coreSignature = buildCoreSignature(payload);
    const duplicate = await CoreMaster.exists({ coreSignature });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_CORE_MESSAGE });
    }

    const skuId = await generateId("coreMasterSkuId", "COR");
    await CoreMaster.create({ ...payload, skuId, coreSignature });

    res.locals.auditDescription = `Created core master "${skuId}" (${payload.vendorName})`;
    req.flash("notification", "Core master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/core" });
  } catch (err) {
    console.error("CORE MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "coreSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_CORE_MESSAGE : "Failed to create core master." });
  }
});

router.put("/api/core/:id", requireAuth, requireCoreMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const coreSignature = buildCoreSignature(payload);
    const duplicate = await CoreMaster.exists({ coreSignature, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_CORE_MESSAGE });
    }

    const updated = await CoreMaster.findByIdAndUpdate(req.params.id, { ...payload, coreSignature }, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Core master not found." });
    }

    res.locals.auditDescription = `Updated core master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("CORE MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "coreSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_CORE_MESSAGE : "Failed to update core master." });
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
