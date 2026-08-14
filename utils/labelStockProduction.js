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
export async function produceDeckle({ labelStock, location, reelMtrs, rate, remarks, layers, createdBy }) {
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
    // stockId is client-supplied -- re-check the material type server-side
    // so a stale/tampered request can't laminate a Deckle out of the wrong
    // raw material.
    const requiredType = String(labelStock[meta.specField]?.[meta.typeField] || "").trim().toUpperCase();
    if (!requiredType) throw new Error(`${meta.label} spec is incomplete on this SKU.`);
    if (String(reel.type || "").trim().toUpperCase() !== requiredType) {
      throw new Error(`${meta.label} reel "${reel.rollId}" does not match this SKU's spec (${requiredType}).`);
    }
    if (reel.location !== location) {
      throw new Error(`${meta.label} reel "${reel.rollId}" is not at "${location}".`);
    }
    if (!(Number(reel.reelMtrs) >= reelMtrs)) {
      throw new Error(`${meta.label} reel "${reel.rollId}" only has ${reel.reelMtrs} mtrs left -- needs ${reelMtrs}.`);
    }
    resolved.push({ layerKey, meta, Model, LogModel, reel });
  }

  const by = createdBy || "SYSTEM";
  const deckleId = await generateRollId(labelStock.productCode);

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
    { $match: { material: labelStock._id, location } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = matBal[0]?.qty || 0;

  const created = await MaterialStock.create({
    material: labelStock._id,
    location,
    quantity: 1,
    reelMtrs,
    rate: numOrUndef(rate),
    rollId: deckleId,
    remarks: remarks?.trim() || undefined,
  });

  await MaterialStockLog.create({
    material: labelStock._id,
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

  return { deckleId, stockId: String(created._id), usedRollIds: resolved.map((r) => r.reel.rollId) };
}
