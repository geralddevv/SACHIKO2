import express from "express";
import mongoose from "mongoose";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import Vendor from "../../models/users/vendor.js";
import Location from "../../models/system/location.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
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
} from "../../utils/releaseLinerRollLabel.js";

const router = express.Router();
const ROLL_ID_PREFIX = "RELEASE";
const MAX_ROLLS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const roundKg = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

const SENSING_VALUES = ["SENSING", "NON-SENSING"];

// Fields shared by every reel in one inward batch (one spec, one invoice) --
// every field Release Master itself carries (type/color/gsm/vendor/make/
// vendorSkuCode/sensing), plus this batch's own location/rate/invoice.
async function buildHeaderPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const header = {
    type: String(body.type || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    vendorId: vendorId || undefined,
    make: String(body.make || "").trim(),
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    // Comes off the chosen Release Master (see the stock model's own note on
    // this field). Anything that isn't one of the two known values is stored
    // blank rather than failing the whole inward on a schema enum.
    sensing: SENSING_VALUES.includes(String(body.sensing || "").trim().toUpperCase())
      ? String(body.sensing).trim().toUpperCase()
      : "",
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
// sorts it -- numeric fields (gsm) sort numerically, everything else
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
// {vendorId, vendorName} pairing Release Master itself stores.
async function distinctVendorPairs(filter) {
  const rows = await ReleaseMaster.aggregate([
    { $match: { ...filter, vendorId: { $ne: null } } },
    { $group: { _id: "$vendorId", vendorName: { $first: "$vendorName" } } },
  ]);
  return rows
    .map((r) => ({ vendorId: String(r._id), vendorName: r.vendorName || "" }))
    .filter((v) => v.vendorName)
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

// Single source of truth for the Add dialog's Type/Color/GSM/Vendor/Make/
// Vendor SKU Code pickers -- every field Release Master itself carries,
// sourced from it instead of a hardcoded list or free typing, so inward
// entry only ever selects a real cataloged spec. Used both for the initial
// page load (`filter: {}`) and /filter-specs (each field narrowed by every
// OTHER currently-selected field, never by itself, so picking a value never
// removes itself from its own list). Same "narrow as you pick" pattern as
// Tape Stock inward (routes/stock/tapeStock.js's /filter-specs) and
// Facestock Stock inward (routes/stock/facestockStock.js's /filter-specs).
async function loadSpecOptions(filter) {
  const [types, colors, sizes, gsms, vendors, makes, vendorSkuCodes] = await Promise.all([
    ReleaseMaster.distinct("type", omit(filter, "type")),
    ReleaseMaster.distinct("color", omit(filter, "color")),
    ReleaseMaster.distinct("size", omit(filter, "size")),
    ReleaseMaster.distinct("gsm", omit(filter, "gsm")),
    distinctVendorPairs(omit(filter, "vendorId")),
    ReleaseMaster.distinct("make", omit(filter, "make")),
    ReleaseMaster.distinct("vendorSkuCode", omit(filter, "vendorSkuCode")),
  ]);
  return {
    types: cleanDistinct(types),
    colors: cleanDistinct(colors),
    sizes: cleanDistinct(sizes),
    gsms: cleanDistinct(gsms, { numeric: true }),
    vendors,
    makes: cleanDistinct(makes),
    vendorSkuCodes: cleanDistinct(vendorSkuCodes),
  };
}

// Groups a Release Master row and a ReleaseLinerStock reel as "the same
// spec" using exactly the fields buildReleaseSignature() (routes/system/
// releaseMaster.js) hashes -- every field the stock schema mirrors from the
// master, so a reel entered against a spec always lands in that spec's
// bucket. Not the hash itself (no need to match the master's stored
// signature, just to group consistently within this one request).
function releaseSpecKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const n = (v) => (v === undefined || v === null || v === "" ? "" : String(Number(v)));
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.vendorSkuCode), s(o.color), s(o.size), n(o.gsm)].join("||");
}

// mtrs actually reserved on WIP Label Stock orders, per Release Master spec
// -- the sum of the picked reels' own reelMtrs, not any estimate of what the
// job will eventually need (there isn't one to know in advance). Scoped to
// assignedMachineId being set -- an order still in Pending (not yet assigned
// to a machine) hasn't committed to a location/timeline yet, so it doesn't
// reserve stock here. Nothing picked yet = nothing allocated for that order,
// even once it's assigned to a machine.
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

  // The actual reels set aside on the assign form, batched in one query -- a
  // layer can hold more than one picked reel (Assign Production's pickers
  // are checkboxes).
  const pickedIds = pending.flatMap((p) =>
    Object.values(p.allottedLayers || {})
      .filter((pick) => pick?.pool === "release")
      .flatMap((pick) => pickStockIds(pick)),
  );
  const pickedReels = pickedIds.length
    ? await ReleaseLinerStock.find({ _id: { $in: pickedIds } }).select("vendorId type make vendorSkuCode color size gsm reelMtrs").lean()
    : [];

  const allottedByKey = new Map();
  const rollsByKey = new Map();
  for (const reel of pickedReels) {
    const key = releaseSpecKey(reel);
    allottedByKey.set(key, (allottedByKey.get(key) || 0) + (Number(reel.reelMtrs) || 0));
    rollsByKey.set(key, (rollsByKey.get(key) || 0) + 1);
  }
  return { allottedByKey, rollsByKey };
}

// Per-REEL (not per-spec) allotment/usage -- same idea, and same "Allotted"
// vs. "Used"/"Live" split, as loadFacestockReelUsage in routes/stock/
// facestockStock.js: "Allotted" is a reel still reserved on paper (assigned
// to a machine, not yet produced -- self-heals once the order is produced,
// same scope as loadAllottedByKey above); "Used" is either permanent (a job
// card's own releaseUsage, mtrsUsed > 0) or live (Start already punched on a
// still-open job -- PendingProduction.liveMaterialInUse.release, no Kg yet).
async function loadReleaseReelUsage() {
  const pending = await PendingProduction.find({
    producedAt: null,
    assignedMachineId: { $ne: null },
    allottedRollIds: { $size: 0 },
  })
    .select("allottedLayers liveMaterialInUse lotNo itemId")
    .populate({ path: "itemId", select: "productCode" })
    .lean();

  const allottedByReel = new Map();
  const usedByReel = new Map();
  const touchUsed = (id, lotNo) => {
    const key = String(id);
    const entry = usedByReel.get(key) || { totalKg: 0, lots: new Set() };
    if (lotNo) entry.lots.add(lotNo);
    usedByReel.set(key, entry);
    return entry;
  };

  for (const p of pending) {
    for (const pick of Object.values(p.allottedLayers || {})) {
      if (pick?.pool !== "release") continue;
      for (const id of pickStockIds(pick)) {
        const key = String(id);
        if (!allottedByReel.has(key)) {
          allottedByReel.set(key, { lotNo: p.lotNo || "", productCode: p.itemId?.productCode || "" });
        }
      }
    }
    const liveRl = Array.isArray(p.liveMaterialInUse?.release) ? p.liveMaterialInUse.release : [];
    for (const id of liveRl) touchUsed(id, p.lotNo);
  }

  const jobCards = await MachineJobCard.find({ "releaseUsage.0": { $exists: true } })
    .select("releaseUsage lotNo productCode")
    .lean();

  for (const jc of jobCards) {
    for (const u of jc.releaseUsage || []) {
      const used = Number(u.mtrsUsed) || 0;
      if (!u.stockId || used <= 0) continue;
      touchUsed(u.stockId, jc.lotNo).totalKg += used;
    }
  }

  return { allottedByReel, usedByReel };
}

// Reorder view for the Masters panel -- current stock (total mtrs still on
// non-empty reels) per master spec vs. its MSQ, plus whether a PO is already
// in flight for it (see models/inventory/PurchaseOrder.js's onModel
// extension for Facestock/Adhesive/Release Master).
async function loadMastersWithStock(stock, reelUsage) {
  const stockByKey = new Map();
  const rollCountByKey = new Map();
  const rollsByKey = new Map();
  // Master-level rollup of usedBy below, "in use now" only -- see
  // routes/stock/facestockStock.js's loadMastersWithStock for the fuller
  // comment.
  const liveRollsByKey = new Map();
  for (const s of stock) {
    if (!s.quantity) continue;
    const key = releaseSpecKey(s);
    stockByKey.set(key, (stockByKey.get(key) || 0) + (Number(s.reelMtrs) || 0));
    rollCountByKey.set(key, (rollCountByKey.get(key) || 0) + (Number(s.quantity) || 0));
    if (!rollsByKey.has(key)) rollsByKey.set(key, []);
    const allottedTo = reelUsage?.allottedByReel?.get(String(s._id)) || null;
    const usedEntry = reelUsage?.usedByReel?.get(String(s._id));
    if (usedEntry && usedEntry.totalKg <= 0) {
      liveRollsByKey.set(key, (liveRollsByKey.get(key) || 0) + 1);
    }
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
      allottedTo,
      usedBy: usedEntry
        ? { totalKg: roundKg(usedEntry.totalKg), lots: [...usedEntry.lots], live: usedEntry.totalKg <= 0 }
        : null,
    });
  }

  const masters = await ReleaseMaster.find().sort({ skuId: 1 }).lean();
  const activePOs = await PurchaseOrder.find({
    onModel: "ReleaseMaster",
    itemId: { $in: masters.map((m) => m._id) },
    status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
  }).select("itemId").lean();
  const activePOSet = new Set(activePOs.map((po) => String(po.itemId)));
  // `rollsByKey` is already taken above (reels in stock), hence the rename.
  const { allottedByKey, rollsByKey: allottedRollsByKey } = await loadAllottedByKey();

  return masters.map((m) => {
    const key = releaseSpecKey(m);
    const currentStock = roundKg(stockByKey.get(key) || 0);
    const rollCount = rollCountByKey.get(key) || 0;
    const msq = Number(m.msq) || 0;
    const rolls = (rollsByKey.get(key) || []).slice().sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
    const allotted = roundKg(allottedByKey.get(key) || 0);
    const available = currentStock;
    return {
      ...m,
      currentStock,
      rollCount,
      rolls,
      allotted,
      allottedRolls: allottedRollsByKey.get(key) || 0,
      liveRolls: liveRollsByKey.get(key) || 0,
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
  const [locations, stock, facestockStock, adhesiveStock, specOptions, reelUsage] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    ReleaseLinerStock.find().sort({ createdAt: -1 }).lean(),
    // Facestock and Adhesive Stock's own value figures, shown alongside
    // Release Liner's on this page's header (this is the shopfloor's one
    // raw-material value overview -- see routes/stock/facestockStock.js's
    // own header) -- each pool's rate can differ reel/drum to reel/drum, so
    // this sums per-reel/drum, same as this page's own totalStockValueOf.
    FacestockStock.find().select("quantity reelMtrs rate").lean(),
    AdhesiveStock.find().select("quantity reelMtrs rate").lean(),
    loadSpecOptions({}),
    loadReleaseReelUsage(),
  ]);
  const masters = await loadMastersWithStock(stock, reelUsage);
  const releaseValue = totalStockValueOf(stock);
  const facestockValue = totalStockValueOf(facestockStock);
  const adhesiveValue = totalStockValueOf(adhesiveStock);
  res.render("stock/releaseLinerStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Liner Stock",
    locations,
    masters,
    releaseValue,
    facestockValue,
    adhesiveValue,
    totalStockValue: releaseValue + facestockValue + adhesiveValue,
    // Sizes the Print dialog's preview frame to the real sticker. Passed
    // from utils/releaseLinerRollLabel.js rather than written into the view,
    // so the frame can't quietly disagree with the label inside it.
    labelSizeMm: { width: LABEL_WIDTH_MM, height: LABEL_HEIGHT_MM },
    ...specOptions,
    notification: req.flash("notification"),
  });
});

router.post("/purchase-order", requireAuth, createLimiter, async (req, res) => {
  try {
    const { masterId, quantity, poNumber, estimatedDate, userLocation, remarks } = req.body;

    const master = await ReleaseMaster.findById(masterId).lean();
    if (!master) return res.status(404).json({ success: false, message: "Release master not found." });
    if (!master.vendorId) return res.status(400).json({ success: false, message: "This release liner has no vendor set." });

    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ success: false, message: "Quantity is required." });
    if (!String(poNumber || "").trim()) return res.status(400).json({ success: false, message: "PO Number is required." });

    const parsedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;
    const performer = req.session?.authUser?.username || "SYSTEM";

    const po = await PurchaseOrder.create({
      onModel: "ReleaseMaster",
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

    res.locals.auditDescription = `Created purchase order "${po.poNumber}" for release liner "${master.skuId}" from "${master.vendorName}" (qty ${po.quantity} kg)`;
    req.flash("notification", "Purchase Order created successfully.");
    res.json({ success: true, redirect: "/sachiko/purchase/pending" });
  } catch (err) {
    console.error("RELEASE LINER CREATE PO ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to create Purchase Order." });
  }
});

router.get("/filter-specs", async (req, res) => {
  try {
    const { type, color, size, gsm, vendorId, make, vendorSkuCode } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (color) filter.color = color;
    if (size) filter.size = size;
    if (gsm) filter.gsm = Number(gsm);
    if (vendorId) filter.vendorId = vendorId;
    if (make) filter.make = make;
    if (vendorSkuCode) filter.vendorSkuCode = vendorSkuCode;

    res.json(await loadSpecOptions(filter));
  } catch (err) {
    console.error("RELEASE LINER STOCK FILTER-SPECS ERROR:", err);
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
      const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, ReleaseLinerStock);
      await ReleaseLinerStock.create({ ...header, ...roll, rollId });
      createdRollIds.push(rollId);
    }

    res.locals.auditDescription = `Added ${createdRollIds.length} release liner stock reel(s) (${header.type}) at "${header.location}": ${createdRollIds.join(", ")}`;
    req.flash("notification", `${createdRollIds.length} release liner reel(s) added successfully!`);
    res.json({ success: true, redirect: "/sachiko/releaselinerstock" });
  } catch (err) {
    console.error("RELEASE LINER STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add release liner stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

// No X-Frame-Options exception is needed for this route, and none should be
// added. The Print dialog does not navigate an iframe here -- it fetches
// this HTML and writes it in as srcdoc (see openLabelDialog in
// views/stock/releaseLinerStock.ejs), and X-Frame-Options governs
// navigations, not inline documents. Pointing a frame at this URL instead
// would follow whatever came back, and an expired session answers 302 ->
// /sachiko/login, which is DENY like the rest of the app: the frame dies on
// the redirect target, where no header set here can reach.

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
// that geometry comes from utils/releaseLinerRollLabel.js (over the shared
// utils/materialRollLabel.js), which derives it from the very coordinates
// SOFT.prn uses, so the browser-printed label and the thermal-printed one
// land identically. This route only looks the reel up and renders the QR.
router.get("/label/:stockId", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return sendLabelError(res, 404, "Roll not found.");

    const reel = await ReleaseLinerStock.findById(stockId)
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

    res.render("stock/releaseLinerRollLabel.ejs", {
      rollId: reel.rollId,
      fields: buildLabelFields(labelInput),
      // Named `mm`, not `layout` -- `layout` is ejs-mate's own helper and a
      // local of that name breaks rendering.
      mm: labelLayoutMm(rollLabelModuleCount(qrPayload)),
      qrDataUrl: await rollLabelQrDataUrl(qrPayload),
    });
  } catch (err) {
    console.error("RELEASE LINER ROLL LABEL ERROR:", err);
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

    const updated = await ReleaseLinerStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }

    res.locals.auditDescription = `Updated release liner stock reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE LINER STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update release liner stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await ReleaseLinerStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }
    res.locals.auditDescription = `Deleted release liner stock reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE LINER STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete release liner stock." });
  }
});

export default router;
