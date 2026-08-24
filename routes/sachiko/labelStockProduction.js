import express from "express";
import mongoose from "mongoose";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import LabelStockAdhesiveBinding from "../../models/sachiko/labelStockAdhesiveBinding.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import {
  POOL_MODELS,
  LAYER_META,
  reelMatchesLayer,
  pickStockIds,
  applyAdhesiveBindings,
  adhesiveIdentityKey,
} from "../../utils/labelStockProduction.js";

const router = express.Router();

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

    // A physical reel/drum can only be mounted on one machine at a time, so
    // once another still-open WIP order (assigned to a machine, not yet
    // produced) holds it, picking it here for THIS order is a swap, not a
    // free pick -- Assign & Continue (POST /labels/production/assign/:id in
    // routes/fairdesk_route.js) pulls it off that other order automatically
    // when it's submitted checked. Still offered here, not excluded, so the
    // operator can see and choose it -- `claimedBy` names which order/lot
    // currently holds it (assignProduction.ejs shows this as a badge and
    // warns before the swap happens). Excludes this same order's own pick,
    // so re-opening Assign Production for the order that already holds a
    // reel still shows it as plain, unclaimed.
    const otherPendingLayers = await PendingProduction.find({
      assignedMachineId: { $ne: null },
      producedAt: null,
      ...(mongoose.isValidObjectId(orderId) ? { _id: { $ne: orderId } } : {}),
      allottedLayers: { $ne: null },
    })
      .select("allottedLayers lotNo itemId")
      .populate({ path: "itemId", select: "productCode" })
      .lean();
    const claimedByReel = new Map();
    for (const p of otherPendingLayers) {
      for (const pick of Object.values(p.allottedLayers || {})) {
        if (pick?.pool !== meta.pool) continue;
        for (const sid of pickStockIds(pick)) {
          const key = String(sid);
          if (!claimedByReel.has(key)) {
            claimedByReel.set(key, { lotNo: p.lotNo || "", productCode: p.itemId?.productCode || "" });
          }
        }
      }
    }

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
      ({ drums: matched, hasBinding } = await applyAdhesiveBindings(reels, itemId));
    } else {
      const reels = await poolMeta.Model.find({ type, location, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
        .sort({ reelMtrs: 1, rollId: 1, createdAt: 1 })
        .lean();
      matched = reels.filter((r) => reelMatchesLayer(meta.pool, r, layerSpec));
    }

    // POOL_MATCH_FIELDS (utils/labelStockProduction.js) no longer narrows on
    // every reel-side field a master carries -- Vendor/Size/GSM (Facestock),
    // Make/Vendor SKU Code/Viscosity/Cohesion/Shear/Density
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
        viscosity: r.viscosity,
        cohesion: r.cohesion,
        shear: r.shear,
        density: r.density,
        reelMtrs: r.reelMtrs,
        rate: r.rate,
        invoiceNo: r.invoiceNo || "",
        claimedBy: claimedByReel.get(String(r._id)) || null,
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
