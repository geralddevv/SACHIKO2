import express from "express";
import crypto from "crypto";
import FacestockMaster from "../../models/inventory/facestockMaster.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import Vendor from "../../models/users/vendor.js";
import Family from "../../models/system/family.js";
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

function buildFacestockSignature(payload) {
  return hashSignature(
    [
      String(payload.vendorId || ""),
      canonStr(payload.family),
      canonStr(payload.make),
      canonStr(payload.vendorSkuCode),
      canonStr(payload.type),
      canonStr(payload.size),
      String(Number(payload.gsm ?? "")),
      String(Number(payload.micron ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_FACESTOCK_MESSAGE = "This facestock already exists (every field matches an existing record).";

// Every field FacestockStock mirrors from its master (see facestockSpecKey,
// routes/stock/facestockStock.js -- stock is grouped under a master by
// matching all of these exactly). Editing a master must carry the same edit
// onto any reel still recorded under the pre-edit spec, or that reel quietly
// stops matching any master row and vanishes from the Stock/Allotted/
// Available columns even though the physical reel is still sitting there.
const STOCK_MIRROR_FIELDS = ["vendorId", "vendorName", "family", "make", "vendorSkuCode", "type", "size", "gsm", "micron"];

// Builds the query that finds every FacestockStock reel still carrying the
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

// Generate a sequential id of the form `SP | FCS | 000001`.
async function generateId(key, code) {
  const [latest, counter] = await Promise.all([
    FacestockMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await FacestockMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  await Counter.updateOne({ key }, { $set: { seq: nextSeq } }, { upsert: true });
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

async function previewId(key, code) {
  const [latest, counter] = await Promise.all([
    FacestockMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await FacestockMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const requireFacestockMaster = requireRole(["proprietor", "admin", "hod"]);

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

async function buildPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const payload = {
    vendorId,
    family: String(body.family || "").trim(),
    make: String(body.make || "").trim(),
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    type: String(body.type || "").trim(),
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    micron: numOrUndef(body.micron),
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
  if (!payload.family) return "Family is required.";
  if (!payload.vendorSkuCode) return "Vendor SKU Code is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/facestock", requireFacestockMaster, async (req, res) => {
  const [facestocks, previewSkuId, vendors, families] = await Promise.all([
    FacestockMaster.find().sort({ skuId: 1 }).lean(),
    previewId("facestockMasterSkuId", "FCS"),
    Vendor.find({ commodities: "FACE PAPER" }, { vendorName: 1 }).sort({ vendorName: 1 }).lean(),
    Family.find().sort({ familyName: 1 }).lean(),
  ]);
  res.render("inventory/masters/facestockMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Facestock Master",
    facestocks,
    previewSkuId,
    vendors,
    families,
    notification: req.flash("notification"),
  });
});

router.post("/form/facestock", requireAuth, requireFacestockMaster, createLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const facestockSignature = buildFacestockSignature(payload);
    const duplicate = await FacestockMaster.exists({ facestockSignature });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_FACESTOCK_MESSAGE });
    }

    const skuId = await generateId("facestockMasterSkuId", "FCS");
    await FacestockMaster.create({ ...payload, skuId, facestockSignature });

    res.locals.auditDescription = `Created facestock master "${skuId}" (${payload.vendorSkuCode})`;
    req.flash("notification", "Facestock master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/facestock" });
  } catch (err) {
    console.error("FACESTOCK MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "facestockSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_FACESTOCK_MESSAGE : "Failed to create facestock master." });
  }
});

router.put("/api/facestock/:id", requireAuth, requireFacestockMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const facestockSignature = buildFacestockSignature(payload);
    const duplicate = await FacestockMaster.exists({ facestockSignature, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_FACESTOCK_MESSAGE });
    }

    const before = await FacestockMaster.findById(req.params.id).lean();
    if (!before) {
      return res.status(404).json({ success: false, message: "Facestock master not found." });
    }

    const updated = await FacestockMaster.findByIdAndUpdate(req.params.id, { ...payload, facestockSignature }, { new: true, runValidators: true });

    const { match, update } = cascadeStockUpdate(before, payload);
    let stockUpdated = 0;
    if (update.$set || update.$unset) {
      const result = await FacestockStock.updateMany(match, update);
      stockUpdated = result.modifiedCount || 0;
    }

    res.locals.auditDescription = `Updated facestock master "${updated.skuId}"`
      + (stockUpdated ? ` -- carried the change onto ${stockUpdated} existing stock reel${stockUpdated === 1 ? "" : "s"}` : "");
    req.flash("notification", stockUpdated
      ? `Facestock master updated -- ${stockUpdated} existing stock reel${stockUpdated === 1 ? "" : "s"} updated to match.`
      : "Facestock master updated successfully!");
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "facestockSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_FACESTOCK_MESSAGE : "Failed to update facestock master." });
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
