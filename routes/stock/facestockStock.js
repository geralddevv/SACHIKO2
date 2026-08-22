import express from "express";
import mongoose from "mongoose";
import FacestockStock from "../../models/inventory/facestockStock.js";
import FacestockMaster from "../../models/inventory/facestockMaster.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import Vendor from "../../models/users/vendor.js";
import Location from "../../models/system/location.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollIds } from "../../utils/materialRollId.js";
import { pickStockIds } from "../../utils/labelStockProduction.js";
import {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  buildLabelFields,
  buildQrPayload,
  labelLayoutMm,
  rollLabelModuleCount,
  rollLabelQrDataUrl,
} from "../../utils/facestockRollLabel.js";

const router = express.Router();
const ROLL_ID_PREFIX = "FACESTOCK";
const MAX_ROLLS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const roundKg = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

// Fields shared by every reel in one inward batch (one spec, one invoice) --
// every field Facestock Master itself carries (family/type/gsm/micron/
// vendor/make/vendorSkuCode), plus this batch's own location/rate/invoice.
async function buildHeaderPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const header = {
    family: String(body.family || "").trim(),
    type: String(body.type || "").trim(),
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    micron: numOrUndef(body.micron),
    vendorId: vendorId || undefined,
    make: String(body.make || "").trim(),
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    location: String(body.location || "").trim(),
    rate: numOrUndef(body.rate),
    invoiceNo: String(body.invoiceNo || "").trim(),
    inwardDate: body.inwardDate ? new Date(body.inwardDate) : new Date(),
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

// Per-reel fields -- one physical reel of the batch's shared spec.
function buildRollPayload(raw) {
  return {
    reelMtrs: Number(raw?.reelMtrs),
    vendorRollId: String(raw?.vendorRollId || "").trim(),
  };
}

// The Edit dialog still edits one existing reel at a time (its own Roll ID
// is already assigned, so there's nothing to batch) -- full single-reel
// payload, same shape as the pre-batch /create used.
async function buildEditPayload(body) {
  const header = await buildHeaderPayload(body);
  return { ...header, ...buildRollPayload(body) };
}

function validateEditPayload(payload) {
  const headerError = validateHeaderPayload(payload);
  if (headerError) return headerError;
  if (!payload.reelMtrs || payload.reelMtrs <= 0) return "Kg is required.";
  return null;
}

// Strips null/undefined/blank entries out of a Mongo .distinct() result and
// sorts it -- numeric fields (gsm/micron) sort numerically, everything else
// alphabetically.
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
// {vendorId, vendorName} pairing Facestock Master itself stores.
async function distinctVendorPairs(filter) {
  const rows = await FacestockMaster.aggregate([
    { $match: { ...filter, vendorId: { $ne: null } } },
    { $group: { _id: "$vendorId", vendorName: { $first: "$vendorName" } } },
  ]);
  return rows
    .map((r) => ({ vendorId: String(r._id), vendorName: r.vendorName || "" }))
    .filter((v) => v.vendorName)
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

// Single source of truth for the Add dialog's Family/Type/GSM/Micron/Vendor/
// Make/Vendor SKU Code pickers -- every field Facestock Master itself
// carries, sourced from it instead of a hardcoded list or free typing, so
// inward entry only ever selects a real cataloged spec. Used both for the
// initial page load (`filter: {}`) and /filter-specs (each field narrowed by
// every OTHER currently-selected field, never by itself, so picking a value
// never removes itself from its own list). Same "narrow as you pick" pattern
// as Tape Stock inward (routes/stock/tapeStock.js's /filter-specs) and the
// Label Stock Binding spec pickers (routes/sachiko/labelStockBinding.js's
// /filter-specs).
async function loadSpecOptions(filter) {
  const [families, types, sizes, gsms, microns, vendors, makes, vendorSkuCodes] = await Promise.all([
    FacestockMaster.distinct("family", omit(filter, "family")),
    FacestockMaster.distinct("type", omit(filter, "type")),
    FacestockMaster.distinct("size", omit(filter, "size")),
    FacestockMaster.distinct("gsm", omit(filter, "gsm")),
    FacestockMaster.distinct("micron", omit(filter, "micron")),
    distinctVendorPairs(omit(filter, "vendorId")),
    FacestockMaster.distinct("make", omit(filter, "make")),
    FacestockMaster.distinct("vendorSkuCode", omit(filter, "vendorSkuCode")),
  ]);
  return {
    families: cleanDistinct(families),
    types: cleanDistinct(types),
    sizes: cleanDistinct(sizes),
    gsms: cleanDistinct(gsms, { numeric: true }),
    microns: cleanDistinct(microns, { numeric: true }),
    vendors,
    makes: cleanDistinct(makes),
    vendorSkuCodes: cleanDistinct(vendorSkuCodes),
  };
}

// Groups a Facestock Master row and a FacestockStock reel as "the same
// spec" using exactly the fields buildFacestockSignature() (routes/system/
// facestockMaster.js) hashes -- every field the stock schema mirrors from
// the master, so a reel entered against a spec always lands in that spec's
// bucket. Not the hash itself (no need to match the master's stored
// signature, just to group consistently within this one request).
function facestockSpecKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const n = (v) => (v === undefined || v === null || v === "" ? "" : String(Number(v)));
  return [String(o.vendorId || ""), s(o.family), s(o.make), s(o.vendorSkuCode), s(o.type), s(o.size), n(o.gsm), n(o.micron)].join("||");
}

// mtrs actually reserved on WIP Label Stock orders, per Facestock Master
// spec -- the sum of the picked reels' own reelMtrs, not any estimate of
// what the job will eventually need (there isn't one to know in advance).
// Scoped to assignedMachineId being set -- an order still in Pending (not
// yet assigned to a machine) hasn't committed to a location/timeline yet, so
// it doesn't reserve stock here. Nothing picked yet = nothing allocated for
// that order, even once it's assigned to a machine.
//
// Once an order is drawn (produceDeckle already laminated a Deckle from it --
// see utils/labelStockProduction.js), its picked reel's own reelMtrs was
// already reduced on the reel itself, so currentStock already reflects that
// consumption. A drawn order is excluded here entirely rather than needing a
// separate "drawn" correction: the alternative (still counting it as
// Allocated) would double-subtract material that's already gone from Stock.
async function loadAllottedByKey() {
  const pending = await PendingProduction.find({
    producedAt: null,
    assignedMachineId: { $ne: null },
    allottedRollIds: { $size: 0 },
  })
    .select("allottedLayers")
    .lean();

  // The actual reels set aside on the assign form, batched across every order
  // in one query. A layer can hold more than one picked reel (Assign
  // Production's pickers are checkboxes).
  const pickedIds = pending.flatMap((p) =>
    Object.values(p.allottedLayers || {})
      .filter((pick) => pick?.pool === "facestock")
      .flatMap((pick) => pickStockIds(pick)),
  );
  const pickedReels = pickedIds.length
    ? await FacestockStock.find({ _id: { $in: pickedIds } }).select("vendorId family make vendorSkuCode type size gsm micron reelMtrs").lean()
    : [];

  const allottedByKey = new Map();
  const rollsByKey = new Map();
  for (const reel of pickedReels) {
    const key = facestockSpecKey(reel);
    allottedByKey.set(key, (allottedByKey.get(key) || 0) + (Number(reel.reelMtrs) || 0));
    rollsByKey.set(key, (rollsByKey.get(key) || 0) + 1);
  }
  return { allottedByKey, rollsByKey };
}

// Reorder view for the Masters panel -- current stock (total mtrs still on
// non-empty reels) per master spec vs. its MSQ, plus whether a PO is already
// in flight for it (see models/inventory/PurchaseOrder.js's onModel
// extension for Facestock/Adhesive/Release Master).
async function loadMastersWithStock(stock) {
  const stockByKey = new Map();
  const rollCountByKey = new Map();
  const rollsByKey = new Map();
  for (const s of stock) {
    if (!s.quantity) continue;
    const key = facestockSpecKey(s);
    stockByKey.set(key, (stockByKey.get(key) || 0) + (Number(s.reelMtrs) || 0));
    rollCountByKey.set(key, (rollCountByKey.get(key) || 0) + (Number(s.quantity) || 0));
    if (!rollsByKey.has(key)) rollsByKey.set(key, []);
    rollsByKey.get(key).push({
      _id: s._id,
      rollId: s.rollId,
      vendorRollId: s.vendorRollId,
      reelMtrs: s.reelMtrs,
      location: s.location,
      rate: s.rate,
      invoiceNo: s.invoiceNo,
      remarks: s.remarks,
      createdAt: s.createdAt,
      inwardDate: s.inwardDate,
    });
  }

  const masters = await FacestockMaster.find().sort({ skuId: 1 }).lean();
  const activePOs = await PurchaseOrder.find({
    onModel: "FacestockMaster",
    itemId: { $in: masters.map((m) => m._id) },
    status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
  }).select("itemId").lean();
  const activePOSet = new Set(activePOs.map((po) => String(po.itemId)));
  // `rollsByKey` is already taken above (reels in stock), hence the rename.
  const { allottedByKey, rollsByKey: allottedRollsByKey } = await loadAllottedByKey();

  return masters.map((m) => {
    const key = facestockSpecKey(m);
    const currentStock = roundKg(stockByKey.get(key) || 0);
    const rollCount = rollCountByKey.get(key) || 0;
    const msq = Number(m.msq) || 0;
    const rolls = (rollsByKey.get(key) || []).slice().sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
    const allotted = roundKg(allottedByKey.get(key) || 0);
    const available = roundKg(currentStock - allotted);
    return {
      ...m,
      currentStock,
      rollCount,
      rolls,
      allotted,
      allottedRolls: allottedRollsByKey.get(key) || 0,
      available,
      shortage: roundKg(Math.max(0, msq - currentStock)),
      hasActivePO: activePOSet.has(String(m._id)),
    };
  });
}

// Rupee value of stock actually on hand right now -- each reel's own
// reelMtrs (Kg) times its own rate (rate can vary reel to reel, batch to
// batch, so this sums per-reel rather than using one blended rate). Reels
// already emptied by Label Stock Production (quantity 0) hold nothing, so
// they contribute nothing, same "quantity > 0" gate loadMastersWithStock
// uses for Stock (Kg).
function totalStockValueOf(stock) {
  return stock.reduce((sum, s) => (s.quantity ? sum + (Number(s.reelMtrs) || 0) * (Number(s.rate) || 0) : sum), 0);
}

router.get("/", async (req, res) => {
  const [locations, stock, releaseStock, adhesiveStock, specOptions] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    FacestockStock.find().sort({ createdAt: -1 }).lean(),
    // Release Liner and Adhesive Stock's own value figures, shown alongside
    // Facestock's on this page's header (this is the shopfloor's one raw-
    // material value overview) -- each pool's rate can differ reel/drum to
    // reel/drum, so this sums per-reel/drum, same as this page's own
    // totalStockValueOf and each pool's own stock page.
    ReleaseLinerStock.find().select("quantity reelMtrs rate").lean(),
    AdhesiveStock.find().select("quantity reelMtrs rate").lean(),
    loadSpecOptions({}),
  ]);
  const masters = await loadMastersWithStock(stock);
  const facestockValue = totalStockValueOf(stock);
  const releaseValue = totalStockValueOf(releaseStock);
  const adhesiveValue = totalStockValueOf(adhesiveStock);
  res.render("stock/facestockStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Facestock Stock",
    locations,
    masters,
    facestockValue,
    releaseValue,
    adhesiveValue,
    totalStockValue: facestockValue + releaseValue + adhesiveValue,
    // Sizes the Print dialog's preview frame to the real sticker. Passed
    // from utils/facestockRollLabel.js rather than written into the view, so
    // the frame can't quietly disagree with the label inside it.
    labelSizeMm: { width: LABEL_WIDTH_MM, height: LABEL_HEIGHT_MM },
    ...specOptions,
    notification: req.flash("notification"),
  });
});

router.post("/purchase-order", requireAuth, createLimiter, async (req, res) => {
  try {
    const { masterId, quantity, poNumber, estimatedDate, userLocation, remarks } = req.body;

    const master = await FacestockMaster.findById(masterId).lean();
    if (!master) return res.status(404).json({ success: false, message: "Facestock master not found." });
    if (!master.vendorId) return res.status(400).json({ success: false, message: "This facestock has no vendor set." });

    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ success: false, message: "Quantity is required." });
    if (!String(poNumber || "").trim()) return res.status(400).json({ success: false, message: "PO Number is required." });

    const parsedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;
    const performer = req.session?.authUser?.username || "SYSTEM";

    const po = await PurchaseOrder.create({
      onModel: "FacestockMaster",
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

    res.locals.auditDescription = `Created purchase order "${po.poNumber}" for facestock "${master.skuId}" from "${master.vendorName}" (qty ${po.quantity} kg)`;
    req.flash("notification", "Purchase Order created successfully.");
    res.json({ success: true, redirect: "/sachiko/purchase/pending" });
  } catch (err) {
    console.error("FACESTOCK CREATE PO ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to create Purchase Order." });
  }
});

router.get("/filter-specs", async (req, res) => {
  try {
    const { family, type, size, gsm, micron, vendorId, make, vendorSkuCode } = req.query;
    const filter = {};
    if (family) filter.family = family;
    if (type) filter.type = type;
    if (size) filter.size = size;
    if (gsm) filter.gsm = Number(gsm);
    if (micron) filter.micron = Number(micron);
    if (vendorId) filter.vendorId = vendorId;
    if (make) filter.make = make;
    if (vendorSkuCode) filter.vendorSkuCode = vendorSkuCode;

    res.json(await loadSpecOptions(filter));
  } catch (err) {
    console.error("FACESTOCK STOCK FILTER-SPECS ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

// Read-only preview of the next `count` Roll IDs -- refreshed by the add
// dialog whenever "No of Rolls" changes, so row 1 always shows the lowest id
// and they read as a consecutive run. Doesn't consume the sequence.
router.get("/preview-roll-ids", async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), MAX_ROLLS_PER_BATCH);
  const rollIds = await previewMaterialRollIds(ROLL_ID_PREFIX, count);
  res.json({ rollIds });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const header = await buildHeaderPayload(req.body);
    const headerError = validateHeaderPayload(header);
    if (headerError) return res.status(400).json({ success: false, message: headerError });
    // Every inward field is mandatory except Invoice No/Remarks (see
    // buildHeaderPayload/validateHeaderPayload) -- Rate specifically, since
    // it's optional on the schema and on the single-reel Edit dialog, is only
    // enforced here at batch-create time.
    if (!header.rate || header.rate <= 0) {
      return res.status(400).json({ success: false, message: "Rate is required." });
    }

    const rawRolls = Array.isArray(req.body.rolls) ? req.body.rolls : [];
    if (!rawRolls.length) return res.status(400).json({ success: false, message: "At least one roll is required." });
    if (rawRolls.length > MAX_ROLLS_PER_BATCH) {
      return res.status(400).json({ success: false, message: `A batch can hold at most ${MAX_ROLLS_PER_BATCH} rolls.` });
    }

    const rolls = rawRolls.map(buildRollPayload);
    const invalidIndex = rolls.findIndex((r) => !r.reelMtrs || r.reelMtrs <= 0);
    if (invalidIndex !== -1) {
      return res.status(400).json({ success: false, message: `Kg is required for roll ${invalidIndex + 1}.` });
    }
    const missingVendorRollIdIndex = rolls.findIndex((r) => !r.vendorRollId);
    if (missingVendorRollIdIndex !== -1) {
      return res.status(400).json({ success: false, message: `Vendor Roll ID is required for roll ${missingVendorRollIdIndex + 1}.` });
    }

    const locationExists = await Location.exists({ locationName: header.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const createdRollIds = [];
    for (const roll of rolls) {
      const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, FacestockStock);
      await FacestockStock.create({ ...header, ...roll, rollId });
      createdRollIds.push(rollId);
    }

    res.locals.auditDescription = `Added ${createdRollIds.length} facestock stock reel(s) (${header.type}) at "${header.location}": ${createdRollIds.join(", ")}`;
    req.flash("notification", `${createdRollIds.length} facestock reel(s) added successfully!`);
    res.json({ success: true, redirect: "/sachiko/facestockstock" });
  } catch (err) {
    console.error("FACESTOCK STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add facestock stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

// No X-Frame-Options exception is needed for this route, and none should be
// added. The Print dialog does not navigate an iframe here -- it fetches
// this HTML and writes it in as srcdoc (see openLabelDialog in
// views/stock/facestockStock.ejs), and X-Frame-Options governs navigations,
// not inline documents. Pointing a frame at this URL instead would follow
// whatever came back, and an expired session answers 302 -> /sachiko/login,
// which is DENY like the rest of the app: the frame dies on the redirect
// target, where no header set here can reach.

// Failures here are read inside that iframe, so they have to BE the page.
// A flash-and-redirect (this file's pattern everywhere else) is invisible in
// a frame -- the operator would get the stock page rendered at sticker size,
// or another blocked navigation -- so this states the problem in the frame
// where the label would have been.
function sendLabelError(res, status, message) {
  res.status(status).type("html").send(
    `<!DOCTYPE html><meta charset="utf-8">`
    + `<div style="font:600 13px/1.5 Arial,Helvetica,sans-serif;color:#b91c1c;`
    + `display:flex;align-items:center;justify-content:center;height:100vh;`
    + `margin:0;text-align:center;padding:0 12px;">${message}</div>`,
  );
}

// The reel's printed sticker, as a page the browser prints: opened in its
// own tab by the Print button on the stock page, it fires the print dialog
// on load so the operator just picks the label printer.
//
// The page is the sticker and nothing else -- one 101.5 x 75.1 mm sheet,
// with each value positioned in the pre-printed box it belongs to. All of
// that geometry comes from utils/facestockRollLabel.js, which derives it
// from the very coordinates SOFT.prn uses, so the browser-printed label and
// the thermal-printed one land identically. This route only looks the reel
// up and renders the QR.
router.get("/label/:stockId", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return sendLabelError(res, 404, "Roll not found.");

    const reel = await FacestockStock.findById(stockId)
      .select("rollId vendorName vendorSkuCode invoiceNo reelMtrs size")
      .lean();
    if (!reel) return sendLabelError(res, 404, "Roll not found.");

    const labelInput = {
      vendorName: reel.vendorName,
      vendorSkuCode: reel.vendorSkuCode,
      invoiceNo: reel.invoiceNo,
      reelMtrs: reel.reelMtrs,
      size: reel.size,
      rollId: reel.rollId,
    };
    // The QR's module count depends on the whole payload's length, so the
    // box can only be sized once the payload exists -- hence building the
    // payload here rather than letting the view ask for a data URL.
    const qrPayload = buildQrPayload(labelInput);

    res.render("stock/facestockRollLabel.ejs", {
      rollId: reel.rollId,
      fields: buildLabelFields(labelInput),
      // Named `mm`, not `layout` -- `layout` is ejs-mate's own helper and a
      // local of that name breaks rendering.
      mm: labelLayoutMm(rollLabelModuleCount(qrPayload)),
      qrDataUrl: await rollLabelQrDataUrl(qrPayload),
    });
  } catch (err) {
    console.error("FACESTOCK ROLL LABEL ERROR:", err);
    sendLabelError(res, 500, "Failed to build the label.");
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

    const updated = await FacestockStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Facestock stock reel not found." });
    }

    res.locals.auditDescription = `Updated facestock stock reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update facestock stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await FacestockStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Facestock stock reel not found." });
    }
    res.locals.auditDescription = `Deleted facestock stock reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FACESTOCK STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete facestock stock." });
  }
});

export default router;
