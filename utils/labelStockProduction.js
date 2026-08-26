import mongoose from "mongoose";
import MaterialStock from "../models/inventory/materialStock.js";
import MaterialStockLog from "../models/inventory/materialStockLog.js";
import FacestockStock from "../models/inventory/facestockStock.js";
import FacestockStockLog from "../models/inventory/facestockStockLog.js";
import AdhesiveStock from "../models/inventory/adhesiveStock.js";
import AdhesiveStockLog from "../models/inventory/adhesiveStockLog.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";
import ReleaseLinerStockLog from "../models/inventory/releaseLinerStockLog.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import LabelStockAdhesiveBinding from "../models/sachiko/labelStockAdhesiveBinding.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import { generateDeckleId } from "./rollId.js";
import { resolveActualLabelStock, resolveLabelStockCombinations } from "./labelStockVariant.js";

// ---------------------------------------------------------------------------
// Label Stock Production -- takes a Label Stock SKU's recipe (facestock +
// adhesive + release liner, see models/sachiko/sachikoLabelStock.js) and
// allocates one physical reel of each raw-material layer it calls for,
// laminating them (in the real-world process) into one finished reel of
// label stock: a "Deckle" -- a MaterialStock row, identified by a Deckle ID
// (MaterialStock.rollId, generated in the production lot format by
// utils/rollId.js). All layers run through the laminator
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
// vendor SKU code/type/micron; Adhesive: type alone; Release Liner: sensing
// alone. Vendor itself and every other master field
// (Facestock's size/gsm; Adhesive's make/vendor SKU code/
// viscosity/cohesion/shear/density; Release's type/make/vendor SKU code/
// color/size/gsm) are NOT checked here
// -- a reel only needs to agree with the recipe on this list to count as
// usable, even if it differs from the recipe's exact master elsewhere.
// Drives reelMatchesLayer() below, the single check both the raw-stock picker
// (routes/sachiko/labelStockProduction.js) and produceDeckle() use.
//
// Narrower is not "looser accounting": every field left out here is still
// part of buildLabelStockSpecSignature (utils/labelStockVariant.js), so
// picking a reel that differs on one doesn't quietly get counted as the SKU's
// own material -- it's tracked as that SKU's "-A"/"-B"/... Product Code
// variant instead (resolveLabelStockCombinations, called from Assign
// Production). Facestock GSM and Adhesive make/vendor SKU code moved from the
// first list to the second on purpose: a 78 GSM reel is an acceptable stand-in
// for an 80 GSM one, and any adhesive of the right type will bond -- so they
// belong in the picker, under their own variant code, not hidden from it.
export const POOL_MATCH_FIELDS = {
  facestock: [
    { field: "family", recipe: "facestockFamily" },
    { field: "gsm", recipe: "facestockGsm", numeric: true },
    { field: "micron", recipe: "facestockMicron", numeric: true },
    { field: "type", recipe: "facestockType" },
  ],
  adhesive: [
    { field: "type", recipe: "adhesiveType" },
  ],
  release: [
    { field: "sensing", recipe: "releaseLinerSensing" },
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
//
// Release Liner's sensing is one-directional, not a straight equality: a
// SENSING liner physically satisfies a NON-SENSING recipe too (the mark just
// goes unused), so a recipe that only calls for NON-SENSING accepts either.
// The reverse doesn't hold -- a recipe that calls for SENSING still needs a
// liner that actually carries the mark, so that direction stays an exact
// match (including rejecting a reel whose sensing is blank/not yet filled in).
export function reelMatchesLayer(pool, reel, layer) {
  if (!reel || !layer) return false;
  for (const { field, recipe, numeric } of POOL_MATCH_FIELDS[pool] || []) {
    const raw = layer[recipe];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    if (pool === "release" && field === "sensing") {
      const recipeSensing = canonMatch(raw);
      const reelSensing = canonMatch(reel.sensing);
      if (recipeSensing === "NON-SENSING") {
        if (reelSensing !== "NON-SENSING" && reelSensing !== "SENSING") return false;
      } else if (reelSensing !== recipeSensing) {
        return false;
      }
      continue;
    }
    if (numeric) {
      if (Number(reel[field]) !== Number(raw)) return false;
    } else if (canonMatch(reel[field]) !== canonMatch(raw)) {
      return false;
    }
  }
  return true;
}

// PendingProduction.allottedLayers[key] is `{ pool, stockIds: [...] }` --
// Assign Production's raw-material pickers are checkboxes (assignProduction.ejs),
// so a layer can now hold more than one reel picked at once (e.g. combining
// two undersized drums to cover one order, since nothing gets laminated from
// this page anymore -- see the POST handler's dead rawProduceMtrs branch).
// Orders assigned before that changed still have the old singular
// `{ pool, stockId }` shape saved -- normalizing through this helper
// everywhere `allottedLayers` gets read is what keeps both shapes working
// without a data migration.
export function pickStockIds(pick) {
  if (!pick) return [];
  if (Array.isArray(pick.stockIds)) return pick.stockIds.filter(Boolean).map(String);
  return pick.stockId ? [String(pick.stockId)] : [];
}

export function adhesiveIdentityKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.vendorSkuCode)].join("||");
}

export async function applyAdhesiveBindings(drums, labelStockId) {
  const bindings = await LabelStockAdhesiveBinding.find({
    labelStock: labelStockId,
  }).select("adhesive").lean();
  if (!bindings.length) return { drums: [], hasBinding: false };
  if (!drums.length) return { drums, hasBinding: true };

  const masters = await AdhesiveMaster.find({ _id: { $in: bindings.map((b) => b.adhesive) } })
    .select("vendorId type make vendorSkuCode")
    .lean();
  if (!masters.length) return { drums: [], hasBinding: false };

  const allowed = new Set(masters.map(adhesiveIdentityKey));
  return { drums: drums.filter((d) => allowed.has(adhesiveIdentityKey(d))), hasBinding: true };
}

// Resolves all raw-material reels/drums eligible for an order's Label Stock SKU --
// both currently allotted reels and unallocated warehouse stock that satisfies the
// SKU's restrictions:
// - Facestock: matches the core fields (family, make, vendorSkuCode, type, micron) of the product code recipe
// - Adhesive: matches the Adhesive Master(s) bound to the product code
// - Release Liner: matches sensing (SENSING / NON-SENSING) and type
export async function getEligibleRawMaterials({ labelStock, allottedLayers }) {
  if (!labelStock) return { facestock: [], adhesive: [], release: [], validStockIds: { facestock: new Set(), adhesive: new Set(), release: new Set() } };

  const labelStockDoc = (labelStock && typeof labelStock === "object" && labelStock.rollType)
    ? labelStock
    : await SachikoLabelStock.findById(labelStock).lean();

  if (!labelStockDoc) {
    return { facestock: [], adhesive: [], release: [], validStockIds: { facestock: new Set(), adhesive: new Set(), release: new Set() } };
  }

  const layers = requiredLayersFor(labelStockDoc.rollType);
  const allottedIdsByPool = { facestock: new Set(), adhesive: new Set(), release: new Set() };
  if (allottedLayers) {
    for (const key of layers) {
      const pick = allottedLayers[key];
      const pool = LAYER_META[key]?.pool;
      if (pool && pick) {
        pickStockIds(pick).forEach((id) => allottedIdsByPool[pool].add(String(id)));
      }
    }
  }

  // 1. Facestock (allotted + reels matching core fields of C011/recipe)
  const fsLayers = layers.filter((k) => LAYER_META[k]?.pool === "facestock");
  const fsAllottedIds = [...allottedIdsByPool.facestock];
  const fsDocs = await FacestockStock.find({
    $or: [
      { quantity: { $gt: 0 }, reelMtrs: { $gt: 0 } },
      ...(fsAllottedIds.length ? [{ _id: { $in: fsAllottedIds } }] : []),
    ],
  }).sort({ reelMtrs: -1, rollId: 1 }).lean();
  const facestock = fsDocs
    .filter((r) =>
      allottedIdsByPool.facestock.has(String(r._id)) ||
      fsLayers.some((k) => reelMatchesLayer("facestock", r, labelStockDoc[LAYER_META[k].specField]))
    )
    .map((r) => ({
      _id: String(r._id),
      rollId: r.rollId || "",
      reelMtrs: Number(r.reelMtrs) || 0,
      location: r.location || "",
      code: r.vendorSkuCode || "",
      gsm: r.gsm,
      micron: r.micron,
      size: r.size || "",
      make: r.make || "",
      type: r.type || "",
      family: r.family || "",
      unit: "Roll",
      pool: "facestock",
      layerLabel: "Facestock",
      allotted: allottedIdsByPool.facestock.has(String(r._id)),
    }));

  // 2. Adhesive (allotted + drums matching binding with product code)
  const adLayers = layers.filter((k) => LAYER_META[k]?.pool === "adhesive");
  const adAllottedIds = [...allottedIdsByPool.adhesive];
  const adDocs = await AdhesiveStock.find({
    $or: [
      { quantity: { $gt: 0 }, reelMtrs: { $gt: 0 } },
      ...(adAllottedIds.length ? [{ _id: { $in: adAllottedIds } }] : []),
    ],
  }).sort({ reelMtrs: -1, rollId: 1 }).lean();
  const { drums: boundAdDrums, hasBinding } = await applyAdhesiveBindings(adDocs, labelStockDoc._id);
  const boundAdSet = new Set(boundAdDrums.map((d) => String(d._id)));
  const adhesive = adDocs
    .filter((r) =>
      allottedIdsByPool.adhesive.has(String(r._id)) ||
      (hasBinding ? boundAdSet.has(String(r._id)) : adLayers.some((k) => reelMatchesLayer("adhesive", r, labelStockDoc[LAYER_META[k].specField])))
    )
    .map((r) => ({
      _id: String(r._id),
      rollId: r.rollId || "",
      reelMtrs: Number(r.reelMtrs) || 0,
      location: r.location || "",
      code: r.vendorSkuCode || "",
      gsm: r.gsm,
      size: r.size || "",
      make: r.make || "",
      type: r.type || "",
      unit: "Drum",
      pool: "adhesive",
      layerLabel: "Adhesive",
      allotted: allottedIdsByPool.adhesive.has(String(r._id)),
    }));

  // 3. Release Liner (allotted + reels matching sensing/type)
  const rlLayers = layers.filter((k) => LAYER_META[k]?.pool === "release");
  const rlAllottedIds = [...allottedIdsByPool.release];
  const rlDocs = await ReleaseLinerStock.find({
    $or: [
      { quantity: { $gt: 0 }, reelMtrs: { $gt: 0 } },
      ...(rlAllottedIds.length ? [{ _id: { $in: rlAllottedIds } }] : []),
    ],
  }).sort({ reelMtrs: -1, rollId: 1 }).lean();
  const release = rlDocs
    .filter((r) =>
      allottedIdsByPool.release.has(String(r._id)) ||
      rlLayers.some((k) => reelMatchesLayer("release", r, labelStockDoc[LAYER_META[k].specField]))
    )
    .map((r) => ({
      _id: String(r._id),
      rollId: r.rollId || "",
      reelMtrs: Number(r.reelMtrs) || 0,
      location: r.location || "",
      code: r.vendorSkuCode || "",
      gsm: r.gsm,
      size: r.size || "",
      make: r.make || "",
      type: r.type || "",
      sensing: r.sensing || "",
      unit: "Roll",
      pool: "release",
      layerLabel: "Release Liner",
      allotted: allottedIdsByPool.release.has(String(r._id)),
    }));

  const validStockIds = {
    facestock: new Set(facestock.map((r) => r._id)),
    adhesive: new Set(adhesive.map((r) => r._id)),
    release: new Set(release.map((r) => r._id)),
  };

  return { facestock, adhesive, release, validStockIds };
}

// Reads an order's just-saved allottedLayers back into real reel documents and
// hands them to resolveLabelStockCombinations, so every material combination
// those reels can be laminated into is tracked as its own Product Code
// variant the moment they're allotted -- rather than only the one combination
// that a later Deckle happens to use (produceDeckle -> resolveActualLabelStock,
// which stays as the check for what actually got laminated; by then these
// rows already exist, so it reuses them instead of minting more).
//
// Called from POST /labels/production/assign/:id (routes/fairdesk_route.js).
// Returns null when there's nothing to look at.
export async function trackAllottedCombinations({ labelStock, allottedLayers }) {
  if (!labelStock) return null;

  const pickedLayers = [];
  for (const layerKey of requiredLayersFor(labelStock.rollType)) {
    const meta = LAYER_META[layerKey];
    const stockIds = pickStockIds(allottedLayers?.[layerKey]);
    if (!stockIds.length) continue;
    const { Model } = POOL_MODELS[meta.pool];
    // Sorted, so the letters handed out follow a stable order rather than
    // whatever order the checkboxes happened to submit in.
    const reels = await Model.find({ _id: { $in: stockIds } }).sort({ rollId: 1 }).lean();
    // Only a reel that genuinely satisfies this layer counts as a way of
    // building it -- same gate the picker and produceDeckle apply. A reel
    // that doesn't (a stale/tampered id, or a SKU whose spec was edited after
    // the allotment) can't invent a combination, and so can't mint a
    // Product Code for one.
    const usable = reels.filter((reel) => reelMatchesLayer(meta.pool, reel, labelStock[meta.specField]));
    if (usable.length) pickedLayers.push({ layerKey, pool: meta.pool, reels: usable });
  }
  if (!pickedLayers.length) return null;

  return resolveLabelStockCombinations(labelStock, pickedLayers);
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
export async function produceDeckle({ labelStock, location, reelMtrs, lotNo, size, rate, remarks, layers, createdBy, producedFor }) {
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
  const deckleId = await generateDeckleId(actualLabelStock.productCode, lotNo);

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
    size: String(size ?? "").trim() || undefined,
    lotNo: String(lotNo ?? "").trim() || undefined,
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

// Every laminated web loses this much width off EACH side to the
// laminator/slitter's own guide edges (not usable for any finished roll,
// regardless of recipe or order) -- a fixed physical constant, not a
// per-order setting. Deckle Set factors it into how wide a facestock an
// order actually needs, on top of the rolls themselves.
export const DECKLE_EDGE_TRIM_MM = 5;

// Deckle Set (GET/POST /sachiko/labels/production/deckle-set) -- lists every
// in-stock Facestock size (quantity/reelMtrs > 0), across ALL specs, not
// just ones matching this order's recipe -- the planner may want to see the
// full warehouse picture, or deliberately substitute a close-enough spec.
// Each size is tagged `isRecipeMatch` (does at least one reel of that size
// actually satisfy the recipe the same way production matches reels --
// reelMatchesLayer/POOL_MATCH_FIELDS above, only the first facestock layer,
// DOUBLE FACESTOCK's facestock2 isn't factored in) with its own
// matchingReelCount/matchingKg subtotal, so the UI can show "12 reels in
// stock, 9 of them this spec" rather than silently mixing them together.
//
// neededWidth is the order's finished-roll width times how many rolls get
// slit off one laminated run, PLUS the standard edge trim on both sides
// (a 210mm order needing 2 rolls needs 420mm of usable roll width + 10mm of
// edge trim = a >=430mm web). suggestedSize -- the "Best Fit" -- deliberately
// only ever considers recipe-matching sizes: a numerically closer size in
// the wrong spec still isn't a safe suggestion, even though it's listed.
// If nothing matching is in stock, falls back to the widest matching size
// and flags `short`; if nothing matches at all, suggestedSize is null.
export async function suggestDeckleSize({ labelStock, paperSize, noOfRolls }) {
  const perRollWidth = Number(paperSize) || 0;
  const rolls = Number(noOfRolls) || 1;
  const rollsWidth = round2(perRollWidth * rolls);
  const edgeTrim = DECKLE_EDGE_TRIM_MM * 2;
  const neededWidth = rollsWidth > 0 ? round2(rollsWidth + edgeTrim) : null;

  if (!labelStock?.facestock || !neededWidth) {
    return { neededWidth, rollsWidth: rollsWidth || null, edgeTrim, sizes: [], suggestedSize: null, short: false };
  }

  const reels = await POOL_MODELS.facestock.Model.find({ quantity: { $gt: 0 }, reelMtrs: { $gt: 0 } }).lean();

  // FacestockStock.reelMtrs is Kg despite its name -- raw Facestock is
  // tracked/labelled by weight everywhere in the UI (the inward form's
  // "Quantity (Kg)", the stock view's "Stock (Kg)"/"Available (Kg)"
  // columns, Assign Production's own reel picker column, all read this same
  // field as Kg). Only MaterialStock's reelMtrs (finished Label Stock/
  // Deckle) is real metres. Named totalKg here to not perpetuate that mixup.
  const bySize = new Map();
  for (const r of reels) {
    const size = Number(r.size);
    if (!size) continue;
    const isMatch = reelMatchesLayer("facestock", r, labelStock.facestock);
    const entry = bySize.get(size) || { size, reelCount: 0, totalKg: 0, matchingReelCount: 0, matchingKg: 0 };
    entry.reelCount += 1;
    entry.totalKg = round2(entry.totalKg + (Number(r.reelMtrs) || 0));
    if (isMatch) {
      entry.matchingReelCount += 1;
      entry.matchingKg = round2(entry.matchingKg + (Number(r.reelMtrs) || 0));
    }
    bySize.set(size, entry);
  }

  const sizes = [...bySize.values()]
    .sort((a, b) => a.size - b.size)
    .map((s) => ({ ...s, wastage: round2(s.size - neededWidth), isRecipeMatch: s.matchingReelCount > 0 }));

  const matchingSizes = sizes.filter((s) => s.isRecipeMatch);
  const fit = matchingSizes.find((s) => s.wastage >= 0);
  const suggestedSize = fit ? fit.size : (matchingSizes[matchingSizes.length - 1]?.size ?? null);

  return { neededWidth, rollsWidth, edgeTrim, sizes, suggestedSize, short: !fit && suggestedSize != null };
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
