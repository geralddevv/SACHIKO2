import express from "express";
import mongoose from "mongoose";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import LabelStockAdhesiveBinding from "../../models/sachiko/labelStockAdhesiveBinding.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import { POOL_MODELS, LAYER_META, reelMatchesLayer, pickStockIds } from "../../utils/labelStockProduction.js";

const router = express.Router();

// Says whether an AdhesiveStock drum is an instance of a given Adhesive
// Master: vendor + type + make + vendor SKU code, the fields that identify
// WHICH adhesive it is.
//
// Deliberately narrower than routes/stock/adhesiveStock.js's own
// adhesiveSpecKey(), which also hashes shelf life/viscosity/cohesion/shear/
// density. Those are measured per inward batch, not properties of the spec --
// live data has drums recorded at shelf life 60 against a master that says 30,
// with only one master of that vendor/type/make/code in existence for them to
// have come from. Including them here would drop such drums out of a binding
// that plainly covers them.
function adhesiveIdentityKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.vendorSkuCode)].join("||");
}

// Narrows a Label Stock's adhesive candidates to the Adhesive Master(s) it has
// been bound to (models/sachiko/labelStockAdhesiveBinding.js).
//
// Mandatory per SKU: a recipe's adhesive layer only pins the TYPE, which
// alone isn't enough to say which specific adhesive a SKU should run --
// without a binding telling us exactly which Adhesive Master(s) are correct,
// showing "every drum of that type" would be a guess, not a fact, so an
// unbound SKU gets nothing instead. Returns { drums, hasBinding } so the
// route can tell the frontend "no binding configured" apart from "bound, but
// zero drums in stock currently match".
async function applyAdhesiveBindings(drums, labelStockId) {
  const bindings = await LabelStockAdhesiveBinding.find({
    labelStock: labelStockId,
  }).select("adhesive").lean();
  if (!bindings.length) return { drums: [], hasBinding: false };
  if (!drums.length) return { drums, hasBinding: true };

  const masters = await AdhesiveMaster.find({ _id: { $in: bindings.map((b) => b.adhesive) } })
    .select("vendorId type make vendorSkuCode")
    .lean();
  // Every binding pointing at a master that has since been deleted would
  // otherwise leave an empty allow-list and hide every drum -- treat that the
  // same as "no binding" rather than a silent, unexplained empty picker.
  if (!masters.length) return { drums: [], hasBinding: false };

  const allowed = new Set(masters.map(adhesiveIdentityKey));
  return { drums: drums.filter((d) => allowed.has(adhesiveIdentityKey(d))), hasBinding: true };
}

// Live reel pickers backing the Facestock/Adhesive/Release Liner columns on
// Assign Production (views/inventory/orders/assignProduction.ejs). Actually
// producing a Deckle happens server-side inside that page's own "Assign &
// Continue" submit -- see produceDeckle() in utils/labelStockProduction.js.

// Reels matching the *whole* recipe layer's spec (family/type/make/vendor/
// vendor SKU code/gsm/micron, whichever it actually pins down -- see
// POOL_MATCH_FIELDS/reelMatchesLayer in utils/labelStockProduction.js), still
// in stock, at the chosen location -- one layer of the recipe at a time.
// Takes itemId + layerKey rather than trusting client-supplied spec fields --
// resolved straight off the live SachikoLabelStock doc, the same one
// produceDeckle() re-validates against, so the picker can never offer a reel
// that later fails that check.
router.get("/raw-stock", async (req, res) => {
  try {
    const layerKey = String(req.query.layerKey || "");
    const meta = LAYER_META[layerKey];
    const poolMeta = meta ? POOL_MODELS[meta.pool] : null;
    const itemId = String(req.query.itemId || "");
    const location = String(req.query.location || "").trim();
    const orderId = String(req.query.orderId || "");
    if (!poolMeta || !itemId || !mongoose.isValidObjectId(itemId) || !location) {
      return res.json({ reels: [], hasBinding: true });
    }

    const labelStock = await SachikoLabelStock.findById(itemId).select(meta.specField).lean();
    const layerSpec = labelStock?.[meta.specField];
    // Adhesive no longer keys off the recipe's own Type at all -- a binding
    // (models/sachiko/labelStockAdhesiveBinding.js) is the sole authority on
    // which Adhesive Master(s) are valid for this SKU now, and a binding can
    // legitimately point at a different type than whatever the recipe layer
    // happens to say (the recipe's Type was only ever a loose default, not a
    // hard constraint -- see applyAdhesiveBindings below). Facestock/Release
    // Liner still gate on their own recipe Type as before.
    const type = String(layerSpec?.[meta.typeField] || "").trim();
    if (meta.pool !== "adhesive" && !type) return res.json({ reels: [], hasBinding: true });

    // A physical reel/drum can only be mounted on one machine at a time --
    // once another still-open WIP order (assigned to a machine, not yet
    // produced) holds it, however little of it that order actually needs,
    // it doesn't belong in this picker at all (mirrors the server-side
    // race-guard in fairdesk_route.js's POST /labels/production/assign/:id).
    // Excludes this same order's own pick, so re-opening Assign Production
    // for the order that already holds a reel still offers it back.
    const otherPendingLayers = await PendingProduction.find({
      assignedMachineId: { $ne: null },
      producedAt: null,
      ...(mongoose.isValidObjectId(orderId) ? { _id: { $ne: orderId } } : {}),
      allottedLayers: { $ne: null },
    }).select("allottedLayers").lean();
    const claimedIds = new Set(
      otherPendingLayers.flatMap((p) =>
        Object.values(p.allottedLayers || {})
          .filter((pick) => pick?.pool === meta.pool)
          .flatMap((pick) => pickStockIds(pick)),
      ),
    );

    // Label Stock <-> Adhesive bindings (models/sachiko/labelStockAdhesiveBinding.js).
    // A binding is mandatory before any drum is offered here, and decides
    // which drums outright -- so the adhesive pool skips the recipe-Type
    // query/match entirely (a bound master can be a different type than the
    // recipe's own) and instead lets applyAdhesiveBindings filter straight
    // off every drum at this location. `hasBinding` rides along in the
    // response so assignProduction.ejs can show "No binding configured"
    // instead of an unexplained empty table.
    let matched;
    let hasBinding = true;
    if (meta.pool === "adhesive") {
      const reels = await poolMeta.Model.find({ location, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
        .sort({ reelMtrs: 1, rollId: 1, createdAt: 1 })
        .lean();
      const candidates = reels.filter((r) => !claimedIds.has(String(r._id)));
      ({ drums: matched, hasBinding } = await applyAdhesiveBindings(candidates, itemId));
    } else {
      const reels = await poolMeta.Model.find({ type, location, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
        .sort({ reelMtrs: 1, rollId: 1, createdAt: 1 })
        .lean();
      matched = reels.filter((r) => reelMatchesLayer(meta.pool, r, layerSpec) && !claimedIds.has(String(r._id)));
    }

    // POOL_MATCH_FIELDS (utils/labelStockProduction.js) no longer narrows on
    // every reel-side field a master carries -- Vendor/Size/GSM (Facestock),
    // Make/Vendor SKU Code/Shelf Life/Viscosity/Cohesion/Shear/Density
    // (Adhesive, matched on Type alone), and Size/GSM (Release) can now
    // differ between reels that still count as "the same" material for this
    // layer. Send them along so assignProduction.ejs's roll picker can show
    // whichever of those the picking user still needs to tell candidates
    // apart by -- the fields already pinned down by the match (and so
    // identical across every row here) aren't repeated.
    res.json({
      reels: matched.map((r) => ({
        _id: String(r._id),
        rollId: r.rollId,
        family: r.family,
        type: r.type,
        make: r.make,
        vendorName: r.vendorName,
        vendorSkuCode: r.vendorSkuCode,
        size: r.size,
        gsm: r.gsm,
        micron: r.micron,
        color: r.color,
        sensing: r.sensing,
        shelfLife: r.shelfLife,
        viscosity: r.viscosity,
        cohesion: r.cohesion,
        shear: r.shear,
        density: r.density,
        reelMtrs: r.reelMtrs,
        rate: r.rate,
        invoiceNo: r.invoiceNo || "",
      })),
      // Only meaningful for the adhesive pool -- Facestock/Release Liner have
      // no binding concept, so they're always effectively "true" here.
      hasBinding,
    });
  } catch (err) {
    console.error("RAW STOCK LOOKUP ERROR:", err);
    res.status(500).json({ reels: [], hasBinding: true });
  }
});

export default router;
