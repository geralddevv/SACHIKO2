import express from "express";
import FacestockStock from "../../models/inventory/facestockStock.js";
import FacestockMaster from "../../models/inventory/facestockMaster.js";
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
const ROLL_ID_PREFIX = "FACESTOCK";
const MAX_ROLLS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

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

// mtrs committed to WIP Label Stock orders, per Facestock Master spec, split
// two ways. Scoped to assignedMachineId being set -- an order still in Pending
// (not yet assigned to a machine) hasn't committed to a location/timeline yet,
// so it doesn't reserve stock here. A PendingProduction's own runningMeters is
// exactly how much every layer of its recipe draws off its reel (all layers
// run through the laminator together for the same length), so it's added once
// per matching facestock/facestock2 layer.
//
//   allottedByKey -- everything committed, whether or not it's been drawn yet.
//                    This is the Allotted column: an order that has taken its
//                    material still shows what it took, which is the whole
//                    point of the column.
//   drawnByKey    -- the part of that already laminated into a Deckle.
//
// The split exists because raw facestock is never held in a reserved state:
// Assign & Continue laminates it into a Deckle there and then and takes the
// mtrs straight out (utils/labelStockProduction.js's produceDeckle). So the
// drawn part has already left Stock, and Available must not subtract it a
// second time -- Available = Stock - (Allotted - Drawn). A 1000 m reel fully
// drawn by one order used to read Stock 0, Allotted 1000, Available -1000;
// it now reads Stock 0, Allotted 1000, Available 0. An order assigned but not
// yet produced reads Stock 1000, Allotted 1000, Available 0 -- same free
// figure, reached from the other side.
async function loadAllottedByKey(masters, stockByKey) {
  const pending = await PendingProduction.find({ producedAt: null, assignedMachineId: { $ne: null } })
    .select("itemId runningMeters allottedRollIds allottedLayers")
    .populate({ path: "itemId", select: "rollType facestock facestock2" })
    .lean();

  // The actual reels set aside on the assign form, batched across every order
  // in one query. Where an order names one, it beats any amount of spec
  // matching: the reel says which master row this order's mtrs belong to, and
  // is what makes the roll count a real count rather than an estimate.
  const pickedIds = pending.flatMap((p) =>
    Object.values(p.allottedLayers || {})
      .filter((pick) => pick?.pool === "facestock" && pick?.stockId)
      .map((pick) => pick.stockId),
  );
  const pickedReels = pickedIds.length
    ? await FacestockStock.find({ _id: { $in: pickedIds } }).lean()
    : [];
  const reelById = new Map(pickedReels.map((r) => [String(r._id), r]));

  const allottedByKey = new Map();
  const drawnByKey = new Map();
  const rollsByKey = new Map();
  // reelMatchesLayer() (utils/labelStockProduction.js) checks every field
  // the recipe layer actually specifies and treats a blank one as "no
  // constraint" -- e.g. a Label Stock saved before facestockSize existed has
  // no Size opinion at all, so it matches every master agreeing on everything
  // else. That's deliberate on the matching side: a plain key-equality lookup
  // (comparing a recipe-built key against each master's full spec key) would
  // require the master's Size to be blank too, which no real master ever is,
  // and would silently drop the demand instead.
  //
  // But an order only ever draws ONE reel, so its metres belong on one master
  // row. Charging every match, as this used to, showed a single 1000 m order
  // as 1000 m allotted against each of three CHROMO/GLOSSY specs differing
  // only by Size -- 3000 m of demand that does not exist. Pick one instead:
  // preferably a candidate that actually holds stock (that's the one the
  // raw-stock picker will offer at Assign & Continue), and with none or
  // several stocked, the lowest skuId so the row it lands on is stable
  // between requests rather than following master insertion order.
  const pickDemandTarget = (matches) => {
    const stocked = matches.filter((m) => (stockByKey.get(facestockSpecKey(m)) || 0) > 0);
    const pool = stocked.length ? stocked : matches;
    return pool
      .slice()
      .sort((a, b) => String(a.skuId || "").localeCompare(String(b.skuId || "")))[0];
  };

  // `pick` is the reel this order actually set aside for the layer, when it
  // has one. It settles both questions at once: which master row the mtrs
  // belong to (exactly, no matching needed) and that one whole roll is
  // committed. Only an order with no reel picked yet falls back to matching
  // the recipe against the masters.
  const addDemand = (layer, mtrs, drawn, pick) => {
    if (!layer || !layer.facestockType || !mtrs) return;
    const reel = pick?.pool === "facestock" && pick?.stockId ? reelById.get(String(pick.stockId)) : null;

    let specKey;
    if (reel) {
      specKey = facestockSpecKey(reel);
    } else {
      const matches = masters.filter((m) => reelMatchesLayer("facestock", m, layer));
      if (!matches.length) return;
      specKey = facestockSpecKey(pickDemandTarget(matches));
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
    // A Deckle reel on the order is proof its facestock has already been
    // laminated and taken out of Stock -- every Deckle is produced by
    // produceDeckle, which deducts each layer as it goes. Deliberately not
    // keyed on allottedLayers: that records the reels *picked* on the assign
    // form even when nothing was produced from them (no produce mtrs entered,
    // no machine location, produceDeckle threw), and those orders haven't
    // drawn anything yet.
    const drawn = (p.allottedRollIds || []).length > 0;
    const layers = requiredLayersFor(labelStock.rollType);
    if (layers.includes("facestock")) addDemand(labelStock.facestock, mtrs, drawn, p.allottedLayers?.facestock);
    if (layers.includes("facestock2")) addDemand(labelStock.facestock2, mtrs, drawn, p.allottedLayers?.facestock2);
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
  const { allottedByKey, drawnByKey, rollsByKey: allottedRollsByKey } = await loadAllottedByKey(masters, stockByKey);

  return masters.map((m) => {
    const key = facestockSpecKey(m);
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
    FacestockStock.find().sort({ createdAt: -1 }).lean(),
    loadSpecOptions({}),
  ]);
  const masters = await loadMastersWithStock(stock);
  res.render("stock/facestockStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Facestock Stock",
    locations,
    masters,
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
