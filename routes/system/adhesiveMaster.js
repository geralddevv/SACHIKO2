import express from "express";
import crypto from "crypto";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
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

function buildAdhesiveSignature(payload) {
  return hashSignature(
    [
      String(payload.vendorId || ""),
      canonStr(payload.type),
      canonStr(payload.make),
      canonStr(payload.vendorSkuCode),
      canonStr(payload.shelfLife),
      String(Number(payload.viscosity ?? "")),
      String(Number(payload.cohesion ?? "")),
      String(Number(payload.shear ?? "")),
      String(Number(payload.density ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_ADHESIVE_MESSAGE = "This adhesive already exists (every field matches an existing record).";

// Every field AdhesiveStock mirrors from its master (see adhesiveSpecKey,
// routes/stock/adhesiveStock.js -- stock is grouped under a master by
// matching all of these exactly, including Shelf Life, since two masters can
// legitimately differ only by it). Editing a master must carry the same edit
// onto any drum still recorded under the pre-edit spec, or that drum quietly
// stops matching any master row and vanishes from the Stock/Allotted/
// Available columns (and everywhere else Stock is grouped by master) even
// though the physical drum is still sitting there.
const STOCK_MIRROR_FIELDS = ["vendorId", "vendorName", "type", "make", "vendorSkuCode", "shelfLife", "viscosity", "cohesion", "shear", "density"];

// Builds the query that finds every AdhesiveStock drum still carrying the
// master's PRE-edit identity, and the $set/$unset that brings them onto the
// post-edit one. A field that's now blank/undefined has to $unset, not $set
// with undefined -- Mongo/Mongoose silently drop undefined-valued $set keys,
// which would leave the old value in place.
function cascadeStockUpdate(before, payload) {
  const match = {};
  const $set = {};
  const $unset = {};
  for (const field of STOCK_MIRROR_FIELDS) {
    const oldVal = before[field];
    match[field] = oldVal === undefined || oldVal === null ? { $exists: false } : oldVal;

    const newVal = payload[field];
    if (newVal === undefined || newVal === null || newVal === "") $unset[field] = "";
    else $set[field] = newVal;
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  return { match, update };
}

const parseSkuSeq = (skuId) => {
  const match = String(skuId || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

// Generate a sequential id of the form `SP | ADH | 000001`.
async function generateId(key, code) {
  const [latest, counter] = await Promise.all([
    AdhesiveMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await AdhesiveMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  await Counter.updateOne({ key }, { $set: { seq: nextSeq } }, { upsert: true });
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

async function previewId(key, code) {
  const [latest, counter] = await Promise.all([
    AdhesiveMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await AdhesiveMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
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
  if (!payload.vendorSkuCode) return "Vendor SKU Code is required.";
  if (!payload.shelfLife) return "Shelf Life is required.";
  return null;
}

router.get("/form/adhesive", requireAdhesiveMaster, async (req, res) => {
  const [adhesives, previewSkuId, vendors] = await Promise.all([
    AdhesiveMaster.find().sort({ skuId: 1 }).lean(),
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

    const adhesiveSignature = buildAdhesiveSignature(payload);
    const duplicate = await AdhesiveMaster.exists({ adhesiveSignature });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_ADHESIVE_MESSAGE });
    }

    const skuId = await generateId("adhesiveMasterSkuId", "ADH");
    await AdhesiveMaster.create({ ...payload, skuId, adhesiveSignature });

    res.locals.auditDescription = `Created adhesive master "${skuId}" (${payload.vendorSkuCode})`;
    req.flash("notification", "Adhesive master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/adhesive" });
  } catch (err) {
    console.error("ADHESIVE MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "adhesiveSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_ADHESIVE_MESSAGE : "Failed to create adhesive master." });
  }
});

router.put("/api/adhesive/:id", requireAuth, requireAdhesiveMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const adhesiveSignature = buildAdhesiveSignature(payload);
    const duplicate = await AdhesiveMaster.exists({ adhesiveSignature, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_ADHESIVE_MESSAGE });
    }

    const before = await AdhesiveMaster.findById(req.params.id).lean();
    if (!before) {
      return res.status(404).json({ success: false, message: "Adhesive master not found." });
    }

    const updated = await AdhesiveMaster.findByIdAndUpdate(req.params.id, { ...payload, adhesiveSignature }, { new: true, runValidators: true });

    const { match, update } = cascadeStockUpdate(before, payload);
    let stockUpdated = 0;
    if (update.$set || update.$unset) {
      const result = await AdhesiveStock.updateMany(match, update);
      stockUpdated = result.modifiedCount || 0;
    }

    res.locals.auditDescription = `Updated adhesive master "${updated.skuId}"`
      + (stockUpdated ? ` -- carried the change onto ${stockUpdated} existing stock drum${stockUpdated === 1 ? "" : "s"}` : "");
    req.flash("notification", stockUpdated
      ? `Adhesive master updated -- ${stockUpdated} existing stock drum${stockUpdated === 1 ? "" : "s"} updated to match.`
      : "Adhesive master updated successfully!");
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "adhesiveSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_ADHESIVE_MESSAGE : "Failed to update adhesive master." });
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
