import express from "express";
import crypto from "crypto";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
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

function buildReleaseSignature(payload) {
  return hashSignature(
    [
      String(payload.vendorId || ""),
      canonStr(payload.type),
      canonStr(payload.make),
      canonStr(payload.vendorSkuCode),
      canonStr(payload.color),
      canonStr(payload.size),
      String(Number(payload.gsm ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_RELEASE_MESSAGE = "This release liner already exists (every field matches an existing record).";

// Same "SP | <CODE> | 000001" id scheme used for Machine/Label Stock/Job Card
const parseSkuSeq = (skuId) => {
  const match = String(skuId || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

// Generate a sequential id of the form `SP | REL | 000001`.
async function generateId(key, code) {
  const [latest, counter] = await Promise.all([
    ReleaseMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await ReleaseMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  await Counter.updateOne({ key }, { $set: { seq: nextSeq } }, { upsert: true });
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

async function previewId(key, code) {
  const [latest, counter] = await Promise.all([
    ReleaseMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await ReleaseMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
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
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    msq: numOrUndef(body.msq),
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
    ReleaseMaster.find().sort({ skuId: 1 }).lean(),
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

    const releaseSignature = buildReleaseSignature(payload);
    const duplicate = await ReleaseMaster.exists({ releaseSignature });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_RELEASE_MESSAGE });
    }

    const skuId = await generateId("releaseMasterSkuId", "REL");
    await ReleaseMaster.create({ ...payload, skuId, releaseSignature });

    res.locals.auditDescription = `Created release master "${skuId}" (${payload.vendorName})`;
    req.flash("notification", "Release master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/release" });
  } catch (err) {
    console.error("RELEASE MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "releaseSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_RELEASE_MESSAGE : "Failed to create release master." });
  }
});

router.put("/api/release/:id", requireAuth, requireReleaseMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const releaseSignature = buildReleaseSignature(payload);
    const duplicate = await ReleaseMaster.exists({ releaseSignature, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_RELEASE_MESSAGE });
    }

    const updated = await ReleaseMaster.findByIdAndUpdate(req.params.id, { ...payload, releaseSignature }, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }

    res.locals.auditDescription = `Updated release master "${updated.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "releaseSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_RELEASE_MESSAGE : "Failed to update release master." });
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
