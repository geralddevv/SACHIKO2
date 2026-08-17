import mongoose from "mongoose";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import FacestockStock from "../models/inventory/facestockStock.js";
import FacestockStockLog from "../models/inventory/facestockStockLog.js";
import AdhesiveStock from "../models/inventory/adhesiveStock.js";
import AdhesiveStockLog from "../models/inventory/adhesiveStockLog.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";
import ReleaseLinerStockLog from "../models/inventory/releaseLinerStockLog.js";
import { generateRollId } from "./rollId.js";
import { resolveActualLabelStock } from "./labelStockVariant.js";

// ---------------------------------------------------------------------------
// Label Stock Production -- takes a Label Stock SKU's recipe (facestock +
// adhesive + release liner, see models/sachiko/sachikoLabelStock.js) and
// allocates one physical reel of each raw-material layer it calls for,
// laminating them (in the real-world process) into one finished reel of
// label stock: a "Deckle" -- a MaterialStock row, identified by a Deckle ID
// (MaterialStock.rollId, generated the same way FAIRTECH generates paper
// roll ids -- see utils/rollId.js). All layers run through the laminator
// together, so they all consume the same length; the mtrs produced is the
// mtrs drawn off every allocated reel.
//
// produceDeckle() is called directly from routes/fairdesk_route.js's POST
// /labels/production/assign/:id -- Assign Production's own "Assign &
// Continue" submit is what triggers production (see the Facestock/Adhesive/
// Release Liner reel columns on views/inventory/orders/assignProduction.ejs),
// not a separate dialog or API call. routes/sachiko/labelStockProduction.js
// only exposes the /raw-stock GET endpoint that backs that page's live reel
// pickers.
//
// Order mirrors labelStockForm.ejs's ROLL_TYPE_ORDER (ls-block ordering) --
// keep the two in step.
// ---------------------------------------------------------------------------
export const LAYER_ORDER = {
  NORMAL: ["facestock", "adhesive", "releaseLiner"],
  "DOUBLE RELEASE": ["facestock", "adhesive", "releaseLiner", "adhesive2", "releaseLiner2"],
  "DOUBLE FACESTOCK": ["facestock", "adhesive", "facestock2", "adhesive2", "releaseLiner"],
};

// `unit` names the physical container each pool's reel actually is -- most
// are rolls, but Adhesive stock is drummed, not reeled (see the "specific
// drum" comment on models/inventory/adhesiveStock.js). Single source of
// truth for that wording everywhere a layer's allocation is displayed
// (assignProduction.ejs, machineQueue.ejs via routes/system/machine.js).
export const LAYER_META = {
  facestock: { pool: "facestock", label: "Facestock", specField: "facestock", typeField: "facestockType", unit: "Roll" },
  adhesive: { pool: "adhesive", label: "Adhesive", specField: "adhesive", typeField: "adhesiveType", unit: "Drum" },
  releaseLiner: { pool: "release", label: "Release Liner", specField: "releaseLiner", typeField: "releaseLinerType", unit: "Roll" },
  facestock2: { pool: "facestock", label: "Facestock (Layer 2)", specField: "facestock2", typeField: "facestockType", unit: "Roll" },
  adhesive2: { pool: "adhesive", label: "Adhesive (Layer 2)", specField: "adhesive2", typeField: "adhesiveType", unit: "Drum" },
  releaseLiner2: { pool: "release", label: "Release Liner (Layer 2)", specField: "releaseLiner2", typeField: "releaseLinerType", unit: "Roll" },
};

export const POOL_MODELS = {
  facestock: { Model: FacestockStock, LogModel: FacestockStockLog },
  adhesive: { Model: AdhesiveStock, LogModel: AdhesiveStockLog },
  release: { Model: ReleaseLinerStock, LogModel: ReleaseLinerStockLog },
};

// The deliberately narrow set of reel-side fields a recipe layer's material
// is considered "the same as" for allocation purposes, paired with the
// recipe's own (prefixed) field name for each -- Facestock: family/make/
// vendor SKU code/type/gsm/micron; Adhesive: type/make/vendor SKU code;
// Release Liner: type/make/vendor SKU code/color. Vendor itself and every
// other master field (Size; Adhesive's shelf life/viscosity/cohesion/shear/
// density; Release's size/gsm) are NOT checked here -- a reel only needs to
// agree with the recipe on this list to count as usable, even if it differs
// from the recipe's exact master elsewhere. Drives reelMatchesLayer() below,
// the single check both the raw-stock picker (routes/sachiko/
// labelStockProduction.js) and produceDeckle() use.
export const POOL_MATCH_FIELDS = {
  facestock: [
    { field: "family", recipe: "facestockFamily" },
    { field: "make", recipe: "facestockMake" },
    { field: "vendorSkuCode", recipe: "facestockVendorSkuCode" },
    { field: "type", recipe: "facestockType" },
    { field: "gsm", recipe: "facestockGsm", numeric: true },
    { field: "micron", recipe: "facestockMicron", numeric: true },
  ],
  adhesive: [
    { field: "type", recipe: "adhesiveType" },
    { field: "make", recipe: "adhesiveMake" },
    { field: "vendorSkuCode", recipe: "adhesiveVendorSkuCode" },
  ],
  release: [
    { field: "type", recipe: "releaseLinerType" },
    { field: "make", recipe: "releaseLinerMake" },
    { field: "vendorSkuCode", recipe: "releaseLinerVendorSkuCode" },
    { field: "color", recipe: "releaseLinerColor" },
  ],
};

const canonMatch = (v) => String(v ?? "").trim().toUpperCase();

// True when every field the recipe layer actually specifies agrees with the
// reel -- a recipe field left blank (Make/Vendor SKU Code are optional on the
// Label Stock form) imposes no constraint, same "no value = no narrowing"
// rule the form's own smart-filter cascade uses. gsm/micron compare
// numerically (a select's string value vs. the reel's stored Number);
// everything else is a canonicalized string compare, matching
// *SpecKey/*RecipeKey's own canonStr in routes/stock/*.js.
export function reelMatchesLayer(pool, reel, layer) {
  if (!reel || !layer) return false;
  for (const { field, recipe, numeric } of POOL_MATCH_FIELDS[pool] || []) {
    const raw = layer[recipe];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    if (numeric) {
      if (Number(reel[field]) !== Number(raw)) return false;
    } else if (canonMatch(reel[field]) !== canonMatch(raw)) {
      return false;
    }
  }
  return true;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export function requiredLayersFor(rollType) {
  return LAYER_ORDER[rollType] || LAYER_ORDER.NORMAL;
}

// Resolves + validates one reel of each layer this recipe needs, deducts
// the produced length from each, laminates them into a new MaterialStock
// (Deckle) row, and logs every movement. Throws a plain Error (readable
// `.message`) on any validation failure -- nothing is written until every
// layer has been confirmed, so a bad pick on the last layer can't leave the
// earlier ones half-consumed.
//
// `labelStock` must be a full SachikoLabelStock doc (not a field-limited
// projection) -- every layer's spec is read off it. `layers` is
// { layerKey: rawStockId }, one entry per key requiredLayersFor(rollType)
// calls for.
export async function produceDeckle({ labelStock, location, reelMtrs, rate, remarks, layers, createdBy, producedFor }) {
  if (!labelStock) throw new Error("Label Stock SKU not found.");
  if (!location) throw new Error("A stock location is required.");
  reelMtrs = Number(reelMtrs);
  if (!reelMtrs || reelMtrs <= 0) throw new Error("Enter the mtrs to produce.");

  const required = requiredLayersFor(labelStock.rollType);
  const resolved = [];
  for (const layerKey of required) {
    const meta = LAYER_META[layerKey];
    const { Model, LogModel } = POOL_MODELS[meta.pool];
    const stockId = layers?.[layerKey];
    if (!stockId || !mongoose.isValidObjectId(stockId)) {
      throw new Error(`Select a reel for ${meta.label}.`);
    }
    const reel = await Model.findById(stockId);
    if (!reel) throw new Error(`${meta.label} reel not found.`);

    // The client only offers reels matching the SKU's spec, but the picked
    // stockId is client-supplied -- re-check the material's *whole* recorded
    // identity server-side (family/type/make/vendor/vendor SKU code/gsm/
    // micron, whichever the recipe actually pins down -- see
    // POOL_MATCH_FIELDS/reelMatchesLayer above), not just Type, so a
    // stale/tampered request can't laminate a Deckle out of raw material that
    // only coincidentally shares this SKU's Type.
    const layerSpec = labelStock[meta.specField];
    const requiredType = String(layerSpec?.[meta.typeField] || "").trim().toUpperCase();
    if (!requiredType) throw new Error(`${meta.label} spec is incomplete on this SKU.`);
    if (!reelMatchesLayer(meta.pool, reel, layerSpec)) {
      throw new Error(`${meta.label} reel "${reel.rollId}" does not match this SKU's full spec (${requiredType}).`);
    }
    if (reel.location !== location) {
      throw new Error(`${meta.label} reel "${reel.rollId}" is not at "${location}".`);
    }
    if (!(Number(reel.reelMtrs) >= reelMtrs)) {
      throw new Error(`${meta.label} reel "${reel.rollId}" only has ${reel.reelMtrs} mtrs left -- needs ${reelMtrs}.`);
    }
    resolved.push({ layerKey, meta, Model, LogModel, reel });
  }

  // reelMatchesLayer above only enforces POOL_MATCH_FIELDS -- Vendor/Size/
  // etc. are deliberately not part of that check (see that constant's own
  // comment), so the reel actually picked for a layer can legitimately carry
  // a different vendor (or other unmatched field) than this SKU's own stored
  // spec. When that happens, the Deckle being laminated is materially a
  // different combination -- resolveActualLabelStock reconstructs the recipe
  // straight from the picked reels and, if it doesn't match `labelStock`
  // exactly, resolves (or creates) the "-A"/"-B"/... Product Code variant
  // that represents it, so this Deckle -- and the finished stock it becomes
  // -- is tracked under the material it was actually made from rather than
  // silently counted as the original SKU. Order/job identity (PendingProduction
  // itemId) is untouched -- only what actually got produced changes.
  const actualLabelStock = await resolveActualLabelStock(labelStock, resolved);

  const by = createdBy || "SYSTEM";
  const deckleId = await generateRollId(actualLabelStock.productCode);

  for (const { meta, Model, LogModel, reel } of resolved) {
    const remaining = round2(reel.reelMtrs - reelMtrs);
    const emptied = remaining <= 0;

    const bal = await Model.aggregate([
      { $match: { type: reel.type, location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;

    await Model.updateOne(
      { _id: reel._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

    await LogModel.create({
      location: reel.location,
      openingStock,
      quantity: rollsOut,
      closingStock,
      reelMtrs: round2(reelMtrs),
      rate: reel.rate,
      rollId: reel.rollId,
      vendorRollId: reel.vendorRollId,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `${meta.label} allocated to Deckle ${deckleId}${emptied ? " -- reel emptied" : ""}`,
      createdBy: by,
    });
  }

  const matBal = await MaterialStock.aggregate([
    { $match: { material: actualLabelStock._id, location } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = matBal[0]?.qty || 0;

  const created = await MaterialStock.create({
    material: actualLabelStock._id,
    location,
    quantity: 1,
    reelMtrs,
    rate: numOrUndef(rate),
    rollId: deckleId,
    remarks: remarks?.trim() || undefined,
    // Provenance, so sending the order back to Pending can un-make this reel
    // and only this reel -- see dissolveDeckle below.
    producedFor: producedFor && mongoose.isValidObjectId(producedFor) ? producedFor : undefined,
  });

  await MaterialStockLog.create({
    material: actualLabelStock._id,
    location,
    openingStock,
    quantity: 1,
    closingStock: openingStock + 1,
    reelMtrs,
    rate: numOrUndef(rate),
    rollId: deckleId,
    type: "INWARD",
    source: "MANUAL",
    remarks: `Produced from ${resolved.map((r) => r.reel.rollId).join(", ")}`,
    createdBy: by,
  });

  return {
    deckleId,
    stockId: String(created._id),
    usedRollIds: resolved.map((r) => r.reel.rollId),
    // Set only when the material actually laminated differed from
    // `labelStock`'s own spec (e.g. a substituted vendor) and got tracked
    // under its own Product Code variant instead -- lets the caller flash
    // that to whoever assigned this order, since it happens automatically.
    variantProductCode: actualLabelStock.productCode !== labelStock.productCode ? actualLabelStock.productCode : null,
  };
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The exact inverse of produceDeckle(): un-makes one Deckle and puts the mtrs
// back on the raw-material reels it was laminated from. Sending a WIP order
// back to Pending calls this for every reel that order produced -- the order
// no longer holds the material, so neither should the Deckle.
//
// It reverses off the ledger rather than off the order. produceDeckle writes
// one OUTWARD line per layer reading "<Layer> allocated to Deckle <deckleId>",
// carrying the mtrs drawn and the rolls taken out; reading those back names
// the source reels, the exact lengths, and whether a reel was emptied (so its
// quantity comes back too). Deliberately not read off PendingProduction's
// allottedLayers: that only ever holds the *latest* submission's picks, so an
// order that produced twice would restore the second run's reels twice and
// leave the first run's short.
//
// Refuses rather than half-returns: a Deckle that has already been drawn from
// (a job card took metres off it, or it was cut down) cannot make its layers
// whole again, so the caller is told instead of silently restoring the wrong
// length. Nothing is written until every check has passed.
export async function dissolveDeckle({ stockId, createdBy }) {
  const deckle = await MaterialStock.findById(stockId);
  if (!deckle) throw new Error("Deckle reel not found.");

  const inward = await MaterialStockLog.findOne({
    rollId: deckle.rollId,
    type: "INWARD",
    remarks: /^Produced from /,
  }).lean();
  if (!inward) {
    throw new Error(`Deckle ${deckle.rollId} has no lamination record -- nothing to return it to.`);
  }
  if (Number(deckle.quantity) !== 1 || round2(Number(deckle.reelMtrs)) !== round2(Number(inward.reelMtrs))) {
    throw new Error(
      `Deckle ${deckle.rollId} has already been used (${deckle.reelMtrs} of ${inward.reelMtrs} mtrs left) -- its raw material can't be returned.`,
    );
  }

  const by = createdBy || "SYSTEM";
  // Anchored so a longer id starting with this one can't be caught by it; the
  // optional tail is produceDeckle's own " -- reel emptied" suffix.
  const remarkMatch = new RegExp(`allocated to Deckle ${escapeRegExp(deckle.rollId)}(?: --.*)?$`);

  const restored = [];
  const missing = [];
  for (const { Model, LogModel } of Object.values(POOL_MODELS)) {
    const outs = await LogModel.find({ type: "OUTWARD", remarks: remarkMatch }).lean();
    for (const out of outs) {
      const reel = await Model.findOne({ rollId: out.rollId });
      if (!reel) {
        missing.push(out.rollId);
        continue;
      }
      const mtrsBack = round2(Number(out.reelMtrs) || 0);
      const rollsBack = Number(out.quantity) || 0;

      const bal = await Model.aggregate([
        { $match: { type: reel.type, location: reel.location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const openingStock = bal[0]?.qty || 0;

      await Model.updateOne(
        { _id: reel._id },
        { $set: { reelMtrs: round2((Number(reel.reelMtrs) || 0) + mtrsBack), quantity: (Number(reel.quantity) || 0) + rollsBack } },
      );

      await LogModel.create({
        location: reel.location,
        openingStock,
        quantity: rollsBack,
        closingStock: openingStock + rollsBack,
        reelMtrs: mtrsBack,
        rate: reel.rate,
        rollId: reel.rollId,
        vendorRollId: reel.vendorRollId,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `Returned from dissolved Deckle ${deckle.rollId}`,
        createdBy: by,
      });
      restored.push({ rollId: reel.rollId, mtrs: mtrsBack, rolls: rollsBack });
    }
  }

  const matBal = await MaterialStock.aggregate([
    { $match: { material: deckle.material, location: deckle.location } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = matBal[0]?.qty || 0;

  await MaterialStock.deleteOne({ _id: deckle._id });

  await MaterialStockLog.create({
    material: deckle.material,
    location: deckle.location,
    openingStock,
    quantity: 1,
    closingStock: openingStock - 1,
    reelMtrs: deckle.reelMtrs,
    rate: deckle.rate,
    rollId: deckle.rollId,
    type: "OUTWARD",
    source: "SYSTEM",
    remarks: `Dissolved -- returned to ${restored.map((r) => r.rollId).join(", ") || "(no reel found)"}`,
    createdBy: by,
  });

  return { deckleId: deckle.rollId, mtrs: Number(deckle.reelMtrs) || 0, restored, missing };
}
