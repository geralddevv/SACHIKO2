import express from "express";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import Vendor from "../../models/users/vendor.js";
import Location from "../../models/system/location.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollIds } from "../../utils/materialRollId.js";
import { requiredLayersFor, reelMatchesLayer } from "../../utils/labelStockProduction.js";

const router = express.Router();
const ROLL_ID_PREFIX = "RELEASE";
const MAX_ROLLS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

// Fields shared by every reel in one inward batch (one spec, one invoice) --
// every field Release Master itself carries (type/color/gsm/vendor/make/
// vendorSkuCode), plus this batch's own location/rate/invoice.
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

// mtrs committed to WIP Label Stock orders, per Release Master spec, split
// into everything committed (allottedByKey -- the Allotted column) and the
// part already laminated into a Deckle (drawnByKey). Scoped to
// assignedMachineId being set -- an order still in Pending (not yet assigned
// to a machine) hasn't committed to a location/timeline yet, so it doesn't
// reserve stock here. A PendingProduction's own runningMeters is exactly how
// much every layer of its recipe draws off its reel (all layers run through
// the laminator together for the same length), so it's added once per matching
// releaseLiner/releaseLiner2 layer.
//
// The split exists because raw release liner is never held in a reserved
// state -- Assign & Continue draws it straight out, so the drawn part has
// already left Stock and Available must not subtract it again. See the fuller
// note on routes/stock/facestockStock.js's own loadAllottedByKey.
async function loadAllottedByKey(masters, stockByKey) {
  const pending = await PendingProduction.find({ producedAt: null, assignedMachineId: { $ne: null } })
    .select("itemId runningMeters allottedRollIds allottedLayers")
    .populate({ path: "itemId", select: "rollType releaseLiner releaseLiner2" })
    .lean();

  // The actual reels set aside on the assign form, batched in one query --
  // where an order names one it beats spec matching outright, and is what
  // makes the roll count a real count. Same shape as Facestock Stock's own
  // loadAllottedByKey.
  const pickedIds = pending.flatMap((p) =>
    Object.values(p.allottedLayers || {})
      .filter((pick) => pick?.pool === "release" && pick?.stockId)
      .map((pick) => pick.stockId),
  );
  const pickedReels = pickedIds.length
    ? await ReleaseLinerStock.find({ _id: { $in: pickedIds } }).lean()
    : [];
  const reelById = new Map(pickedReels.map((r) => [String(r._id), r]));

  const allottedByKey = new Map();
  const drawnByKey = new Map();
  const rollsByKey = new Map();
  // reelMatchesLayer() (utils/labelStockProduction.js) checks every field
  // the recipe layer actually specifies and treats a blank one as "no
  // constraint" -- e.g. a Label Stock saved before releaseLinerVendorSkuCode/
  // releaseLinerSize existed has no opinion on them at all, so it matches
  // every master agreeing on everything else. That's deliberate on the
  // matching side: a plain key-equality lookup (comparing a recipe-built key
  // against each master's full spec key) would require the master's field to
  // be blank too, which no real master ever is, and would silently drop the
  // demand instead.
  //
  // But an order only ever draws ONE reel, so its metres belong on one master
  // row -- charging every match inflates the column by the number of
  // candidates. Pick one instead: preferably a candidate that actually holds
  // stock (that's the one the raw-stock picker will offer at Assign &
  // Continue), and with none or several stocked, the lowest skuId so the row
  // it lands on is stable between requests. Same rule as Facestock Stock's
  // own loadAllottedByKey (routes/stock/facestockStock.js).
  const pickDemandTarget = (matches) => {
    const stocked = matches.filter((m) => (stockByKey.get(releaseSpecKey(m)) || 0) > 0);
    const pool = stocked.length ? stocked : matches;
    return pool
      .slice()
      .sort((a, b) => String(a.skuId || "").localeCompare(String(b.skuId || "")))[0];
  };

  const addDemand = (layer, mtrs, drawn, pick) => {
    if (!layer || !layer.releaseLinerType || !mtrs) return;
    const reel = pick?.pool === "release" && pick?.stockId ? reelById.get(String(pick.stockId)) : null;

    let specKey;
    if (reel) {
      specKey = releaseSpecKey(reel);
    } else {
      const matches = masters.filter((m) => reelMatchesLayer("release", m, layer));
      if (!matches.length) return;
      specKey = releaseSpecKey(pickDemandTarget(matches));
    }

    allottedByKey.set(specKey, (allottedByKey.get(specKey) || 0) + mtrs);
    if (reel) rollsByKey.set(specKey, (rollsByKey.get(specKey) || 0) + 1);
    if (drawn) drawnByKey.set(specKey, (drawnByKey.get(specKey) || 0) + mtrs);
  };

  for (const p of pending) {
    const labelStock = p.itemId;
    if (!labelStock) continue;
    const mtrs = Number(p.runningMeters) || 0;
    if (!mtrs) continue;
    // A Deckle reel on the order proves its release liner has already been
    // laminated and taken out of Stock. Not keyed on allottedLayers -- that
    // records reels merely *picked* on the assign form, which haven't been
    // drawn from yet.
    const drawn = (p.allottedRollIds || []).length > 0;
    const layers = requiredLayersFor(labelStock.rollType);
    if (layers.includes("releaseLiner")) addDemand(labelStock.releaseLiner, mtrs, drawn, p.allottedLayers?.releaseLiner);
    if (layers.includes("releaseLiner2")) addDemand(labelStock.releaseLiner2, mtrs, drawn, p.allottedLayers?.releaseLiner2);
  }
  return { allottedByKey, drawnByKey, rollsByKey };
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
    const key = releaseSpecKey(s);
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

  const masters = await ReleaseMaster.find().sort({ skuId: 1 }).lean();
  const activePOs = await PurchaseOrder.find({
    onModel: "ReleaseMaster",
    itemId: { $in: masters.map((m) => m._id) },
    status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
  }).select("itemId").lean();
  const activePOSet = new Set(activePOs.map((po) => String(po.itemId)));
  // `rollsByKey` is already taken above (reels in stock), hence the rename.
  const { allottedByKey, drawnByKey, rollsByKey: allottedRollsByKey } = await loadAllottedByKey(masters, stockByKey);

  return masters.map((m) => {
    const key = releaseSpecKey(m);
    const currentStock = stockByKey.get(key) || 0;
    const rollCount = rollCountByKey.get(key) || 0;
    const msq = Number(m.msq) || 0;
    const rolls = (rollsByKey.get(key) || []).slice().sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
    const allotted = allottedByKey.get(key) || 0;
    // Only the committed mtrs still waiting to be drawn come off Stock -- the
    // drawn part already left it at lamination (see loadAllottedByKey).
    const drawn = drawnByKey.get(key) || 0;
    const available = currentStock - (allotted - drawn);
    return {
      ...m,
      currentStock,
      rollCount,
      rolls,
      allotted,
      allottedRolls: allottedRollsByKey.get(key) || 0,
      drawn,
      available,
      shortage: Math.max(0, msq - currentStock),
      hasActivePO: activePOSet.has(String(m._id)),
    };
  });
}

router.get("/", async (req, res) => {
  const [locations, stock, specOptions] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    ReleaseLinerStock.find().sort({ createdAt: -1 }).lean(),
    loadSpecOptions({}),
  ]);
  const masters = await loadMastersWithStock(stock);
  res.render("stock/releaseLinerStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Liner Stock",
    locations,
    masters,
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
