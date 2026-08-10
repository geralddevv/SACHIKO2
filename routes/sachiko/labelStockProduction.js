import express from "express";
import { POOL_MODELS } from "../../utils/labelStockProduction.js";

const router = express.Router();

// Live reel pickers backing the Facestock/Adhesive/Release Liner columns on
// Assign Production (views/inventory/orders/assignProduction.ejs). Actually
// producing a Deckle happens server-side inside that page's own "Assign &
// Continue" submit -- see produceDeckle() in utils/labelStockProduction.js.

// Reels of the matching raw material type, still in stock, at the chosen
// location -- one layer of the recipe at a time.
router.get("/raw-stock", async (req, res) => {
  try {
    const poolMeta = POOL_MODELS[String(req.query.pool || "")];
    const type = String(req.query.type || "").trim();
    const location = String(req.query.location || "").trim();
    if (!poolMeta || !type || !location) return res.json({ reels: [] });

    const reels = await poolMeta.Model.find({ type, location, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
      .sort({ reelMtrs: 1, rollId: 1, createdAt: 1 })
      .lean();

    res.json({
      reels: reels.map((r) => ({
        _id: String(r._id),
        rollId: r.rollId,
        family: r.family,
        type: r.type,
        gsm: r.gsm,
        micron: r.micron,
        color: r.color,
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
