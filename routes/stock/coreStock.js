import express from "express";
import CoreStock from "../../models/inventory/coreStock.js";
import CoreMaster from "../../models/inventory/coreMaster.js";
import Vendor from "../../models/users/vendor.js";
import Location from "../../models/system/location.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollIds } from "../../utils/materialRollId.js";

const router = express.Router();
const ROLL_ID_PREFIX = "CORE";
const MAX_LOTS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

// Fields shared by every lot in one inward batch (one spec, one invoice) --
// every field Core Master itself carries (type/vendor/make/printType/
// thickness/od/length), plus this batch's own location/rate/invoice.
async function buildHeaderPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const header = {
    type: String(body.type || "").trim(),
    vendorId: vendorId || undefined,
    make: String(body.make || "").trim(),
    printType: String(body.printType || "").trim(),
    thickness: numOrUndef(body.thickness),
    od: numOrUndef(body.od),
    length: numOrUndef(body.length),
    location: String(body.location || "").trim(),
    rate: numOrUndef(body.rate),
    invoiceNo: String(body.invoiceNo || "").trim(),
    remarks: String(body.remarks || "").trim(),
  };

  if (vendorId) {
    const vendor = await Vendor.findById(vendorId).select("vendorName").lean();
    header.vendorName = vendor?.vendorName || "";
  }

  return header;
}

function validateHeaderPayload(header) {
  if (!header.type) return "Type is required.";
  if (!header.location) return "Location is required.";
  return null;
}

// Per-lot fields -- one inward lot of the batch's shared spec.
function buildLotPayload(raw) {
  return {
    quantity: Number(raw?.quantity),
    vendorRollId: String(raw?.vendorRollId || "").trim(),
  };
}

// The Edit dialog still edits one existing lot at a time (its own Core ID is
// already assigned, so there's nothing to batch) -- full single-lot payload,
// same shape as the pre-batch /create used.
async function buildEditPayload(body) {
  const header = await buildHeaderPayload(body);
  return { ...header, ...buildLotPayload(body) };
}

function validateEditPayload(payload) {
  const headerError = validateHeaderPayload(payload);
  if (headerError) return headerError;
  if (!payload.quantity || payload.quantity <= 0) return "Pieces is required.";
  return null;
}

// Strips null/undefined/blank entries out of a Mongo .distinct() result and
// sorts it -- numeric fields (thickness/width) sort numerically, everything
// else alphabetically.
function cleanDistinct(values, { numeric = false } = {}) {
  const filtered = (values || []).filter((v) => v !== null && v !== undefined && v !== "");
  return numeric ? filtered.sort((a, b) => a - b) : filtered.sort();
}

function omit(obj, key) {
  const { [key]: _, ...rest } = obj;
  return rest;
}

// vendorId is an ObjectId, not a plain scalar, so it can't go through
// .distinct() + cleanDistinct() like the other fields -- this groups by it
// instead and keeps each vendor's denormalized name for display, the same
// {vendorId, vendorName} pairing Core Master itself stores.
async function distinctVendorPairs(filter) {
  const rows = await CoreMaster.aggregate([
    { $match: { ...filter, vendorId: { $ne: null } } },
    { $group: { _id: "$vendorId", vendorName: { $first: "$vendorName" } } },
  ]);
  return rows
    .map((r) => ({ vendorId: String(r._id), vendorName: r.vendorName || "" }))
    .filter((v) => v.vendorName)
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

// Single source of truth for the Add dialog's Type/Vendor/Make/Print Type/
// Thickness/OD/Length pickers -- every field Core Master itself carries, sourced
// from it instead of a hardcoded list or free typing, so inward entry only
// ever selects a real cataloged spec. Used both for the initial page load
// (`filter: {}`) and /filter-specs (each field narrowed by every OTHER
// currently-selected field, never by itself, so picking a value never
// removes itself from its own list). Same "narrow as you pick" pattern as
// Tape Stock inward and Facestock Stock inward.
async function loadSpecOptions(filter) {
  const [types, vendors, makes, printTypes, thicknesses, ods, lengths] = await Promise.all([
    CoreMaster.distinct("type", omit(filter, "type")),
    distinctVendorPairs(omit(filter, "vendorId")),
    CoreMaster.distinct("make", omit(filter, "make")),
    CoreMaster.distinct("printType", omit(filter, "printType")),
    CoreMaster.distinct("thickness", omit(filter, "thickness")),
    CoreMaster.distinct("od", omit(filter, "od")),
    CoreMaster.distinct("length", omit(filter, "length")),
  ]);
  return {
    types: cleanDistinct(types),
    vendors,
    makes: cleanDistinct(makes),
    printTypes: cleanDistinct(printTypes),
    thicknesses: cleanDistinct(thicknesses, { numeric: true }),
    ods: cleanDistinct(ods, { numeric: true }),
    lengths: cleanDistinct(lengths, { numeric: true }),
  };
}

// Groups a Core Master row and a CoreStock lot as "the same spec" using
// exactly the fields buildCoreSignature() (routes/system/coreMaster.js)
// hashes -- every field the stock schema mirrors from the master, so a lot
// entered against a spec always lands in that spec's bucket. Not the hash
// itself (no need to match the master's stored signature, just to group
// consistently within this one request).
function coreSpecKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const n = (v) => (v === undefined || v === null || v === "" ? "" : String(Number(v)));
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.printType), n(o.thickness), n(o.od), n(o.length)].join("||");
}

// Reorder view for the Masters panel -- current stock (total pieces still in
// non-empty lots) per master spec vs. its MSQ, plus whether a PO is already
// in flight for it (see models/inventory/PurchaseOrder.js's onModel
// extension for Facestock/Adhesive/Release/Core Master). Unlike Facestock/
// Adhesive/Release Liner, Core carries no "Allotted" figure -- it isn't a
// Label Stock production recipe layer (see models/sachiko/sachikoLabelStock.js),
// so there's no PendingProduction demand to net against stock.
async function loadMastersWithStock(stock) {
  const stockByKey = new Map();
  const lotCountByKey = new Map();
  const rollsByKey = new Map();
  for (const s of stock) {
    if (!s.quantity) continue;
    const key = coreSpecKey(s);
    stockByKey.set(key, (stockByKey.get(key) || 0) + (Number(s.quantity) || 0));
    lotCountByKey.set(key, (lotCountByKey.get(key) || 0) + 1);
    if (!rollsByKey.has(key)) rollsByKey.set(key, []);
    rollsByKey.get(key).push({
      _id: s._id,
      rollId: s.rollId,
      vendorRollId: s.vendorRollId,
      quantity: s.quantity,
      location: s.location,
      rate: s.rate,
      invoiceNo: s.invoiceNo,
      remarks: s.remarks,
      createdAt: s.createdAt,
    });
  }

  const masters = await CoreMaster.find().sort({ skuId: 1 }).lean();
  const activePOs = await PurchaseOrder.find({
    onModel: "CoreMaster",
    itemId: { $in: masters.map((m) => m._id) },
    status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
  }).select("itemId").lean();
  const activePOSet = new Set(activePOs.map((po) => String(po.itemId)));

  return masters.map((m) => {
    const key = coreSpecKey(m);
    const currentStock = stockByKey.get(key) || 0;
    const lotCount = lotCountByKey.get(key) || 0;
    const msq = Number(m.msq) || 0;
    const rolls = (rollsByKey.get(key) || []).slice().sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
    return {
      ...m,
      currentStock,
      rollCount: lotCount,
      rolls,
      shortage: Math.max(0, msq - currentStock),
      hasActivePO: activePOSet.has(String(m._id)),
    };
  });
}

// Rupee value of stock actually on hand right now -- each lot's own quantity
// (pieces, Core's stock unit -- see the schema note on models/inventory/
// coreStock.js) times its own rate (rate can vary lot to lot, batch to
// batch, so this sums per-lot rather than using one blended rate).
function totalStockValueOf(stock) {
  return stock.reduce((sum, s) => sum + (Number(s.quantity) || 0) * (Number(s.rate) || 0), 0);
}

router.get("/", async (req, res) => {
  const [locations, stock, specOptions] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    CoreStock.find().sort({ createdAt: -1 }).lean(),
    loadSpecOptions({}),
  ]);
  const masters = await loadMastersWithStock(stock);
  res.render("stock/coreStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Core Stock",
    locations,
    masters,
    totalStockValue: totalStockValueOf(stock),
    ...specOptions,
    notification: req.flash("notification"),
  });
});

router.post("/purchase-order", requireAuth, createLimiter, async (req, res) => {
  try {
    const { masterId, quantity, poNumber, estimatedDate, userLocation, remarks } = req.body;

    const master = await CoreMaster.findById(masterId).lean();
    if (!master) return res.status(404).json({ success: false, message: "Core master not found." });
    if (!master.vendorId) return res.status(400).json({ success: false, message: "This core has no vendor set." });

    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ success: false, message: "Quantity is required." });
    if (!String(poNumber || "").trim()) return res.status(400).json({ success: false, message: "PO Number is required." });

    const parsedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;
    const performer = req.session?.authUser?.username || "SYSTEM";

    const po = await PurchaseOrder.create({
      onModel: "CoreMaster",
      itemId: master._id,
      vendorId: master.vendorId,
      vendorName: master.vendorName,
      userLocation,
      quantity: qty,
      poNumber: String(poNumber).trim(),
      estimatedDate: resolvedDate,
      remarks,
      status: "PENDING",
      createdBy: performer,
    });
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: "CREATED",
      poNumber: po.poNumber,
      quantity: po.quantity,
      performedBy: performer,
    });

    res.locals.auditDescription = `Created purchase order "${po.poNumber}" for core "${master.skuId}" from "${master.vendorName}" (qty ${po.quantity} pcs)`;
    req.flash("notification", "Purchase Order created successfully.");
    res.json({ success: true, redirect: "/sachiko/purchase/pending" });
  } catch (err) {
    console.error("CORE CREATE PO ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to create Purchase Order." });
  }
});

router.get("/filter-specs", async (req, res) => {
  try {
    const { type, vendorId, make, printType, thickness, od, length } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (vendorId) filter.vendorId = vendorId;
    if (make) filter.make = make;
    if (printType) filter.printType = printType;
    if (thickness) filter.thickness = Number(thickness);
    if (od) filter.od = Number(od);
    if (length) filter.length = Number(length);

    res.json(await loadSpecOptions(filter));
  } catch (err) {
    console.error("CORE STOCK FILTER-SPECS ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

// Read-only preview of the next `count` Core IDs -- refreshed by the add
// dialog whenever "No of Lots" changes, so row 1 always shows the lowest id
// and they read as a consecutive run. Doesn't consume the sequence.
router.get("/preview-roll-ids", async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), MAX_LOTS_PER_BATCH);
  const rollIds = await previewMaterialRollIds(ROLL_ID_PREFIX, count);
  res.json({ rollIds });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const header = await buildHeaderPayload(req.body);
    const headerError = validateHeaderPayload(header);
    if (headerError) return res.status(400).json({ success: false, message: headerError });

    const rawLots = Array.isArray(req.body.rolls) ? req.body.rolls : [];
    if (!rawLots.length) return res.status(400).json({ success: false, message: "At least one lot is required." });
    if (rawLots.length > MAX_LOTS_PER_BATCH) {
      return res.status(400).json({ success: false, message: `A batch can hold at most ${MAX_LOTS_PER_BATCH} lots.` });
    }

    const lots = rawLots.map(buildLotPayload);
    const invalidIndex = lots.findIndex((l) => !l.quantity || l.quantity <= 0);
    if (invalidIndex !== -1) {
      return res.status(400).json({ success: false, message: `Pieces is required for lot ${invalidIndex + 1}.` });
    }

    const locationExists = await Location.exists({ locationName: header.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const createdRollIds = [];
    for (const lot of lots) {
      const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, CoreStock);
      await CoreStock.create({ ...header, ...lot, rollId });
      createdRollIds.push(rollId);
    }

    res.locals.auditDescription = `Added ${createdRollIds.length} core stock lot(s) (${header.type}) at "${header.location}": ${createdRollIds.join(", ")}`;
    req.flash("notification", `${createdRollIds.length} core lot(s) added successfully!`);
    res.json({ success: true, redirect: "/sachiko/corestock" });
  } catch (err) {
    console.error("CORE STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add core stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const payload = await buildEditPayload(req.body);
    const error = validateEditPayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const locationExists = await Location.exists({ locationName: payload.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const updated = await CoreStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Core stock lot not found." });
    }

    res.locals.auditDescription = `Updated core stock lot "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("CORE STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update core stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await CoreStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Core stock lot not found." });
    }
    res.locals.auditDescription = `Deleted core stock lot "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("CORE STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete core stock." });
  }
});

export default router;
