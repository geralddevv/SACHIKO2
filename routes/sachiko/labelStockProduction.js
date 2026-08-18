import express from "express";
import mongoose from "mongoose";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import { POOL_MODELS, LAYER_META, reelMatchesLayer, pickStockIds } from "../../utils/labelStockProduction.js";

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
    const matched = reels.filter((r) => reelMatchesLayer(meta.pool, r, layerSpec) && !claimedIds.has(String(r._id)));

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
