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
// Opt-in per SKU: with no ACTIVE binding covering this location the drums come
// back untouched, which is every SKU until someone binds one. A binding with a
// blank location holds everywhere; one naming a location applies only there,
// so a SKU can be restricted at the unit that stocks alternatives and left
// open elsewhere.
async function applyAdhesiveBindings(drums, labelStockId, location) {
  if (!drums.length) return drums;

  const bindings = await LabelStockAdhesiveBinding.find({
    labelStock: labelStockId,
    status: "ACTIVE",
    $or: [{ location: "" }, { location: null }, { location }],
  }).select("adhesive").lean();
  if (!bindings.length) return drums;

  const masters = await AdhesiveMaster.find({ _id: { $in: bindings.map((b) => b.adhesive) } })
    .select("vendorId type make vendorSkuCode")
    .lean();
  // Every binding pointing at a master that has since been deleted would
  // otherwise leave an empty allow-list and hide every drum -- treat that as
  // "nothing effective is bound" rather than silently emptying the picker.
  if (!masters.length) return drums;

  const allowed = new Set(masters.map(adhesiveIdentityKey));
  return drums.filter((d) => allowed.has(adhesiveIdentityKey(d)));
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
      return res.json({ reels: [] });
    }

    const labelStock = await SachikoLabelStock.findById(itemId).select(meta.specField).lean();
    const layerSpec = labelStock?.[meta.specField];
    const type = String(layerSpec?.[meta.typeField] || "").trim();
    if (!type) return res.json({ reels: [] });

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

    const reels = await poolMeta.Model.find({ type, location, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
      .sort({ reelMtrs: 1, rollId: 1, createdAt: 1 })
      .lean();
    let matched = reels.filter((r) => reelMatchesLayer(meta.pool, r, layerSpec) && !claimedIds.has(String(r._id)));

    // Label Stock <-> Adhesive bindings (models/sachiko/labelStockAdhesiveBinding.js).
    // The adhesive layer is matched on Type alone, which offers every drum of
    // that type here; a SKU that has been bound to specific Adhesive Masters
    // is narrowed to drums of those. Opt-in per SKU: no ACTIVE binding for
    // this Label Stock leaves the type-matched list exactly as it was.
    if (meta.pool === "adhesive") {
      matched = await applyAdhesiveBindings(matched, itemId, location);
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
      })),
    });
  } catch (err) {
    console.error("RAW STOCK LOOKUP ERROR:", err);
    res.status(500).json({ reels: [] });
  }
});

export default router;
