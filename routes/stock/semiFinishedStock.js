import express from "express";
import MaterialStock from "../../models/inventory/materialStock.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Semi Finished Goods = Deckle stock (MaterialStock). Deckles are created two
// ways: Assign Production's legacy "Produce New Deckle" section
// (routes/fairdesk_route.js POST /labels/production/assign/:id ->
// produceDeckle() in utils/labelStockProduction.js), and -- the normal path
// now -- one per Production Log row on the machine job card, once the job
// finishes (routes/system/machine.js's produceDecklesFromLog, called from
// POST /machine/jobcard/form). This page is a list/edit/delete view onto
// that same MaterialStock data either way, not a third way to create one.
router.get("/", async (req, res) => {
  const [locations, stock] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    MaterialStock.find()
      .populate({ path: "material", select: "productCode skuCode family" })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  res.render("stock/semiFinishedStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Semi Finished Goods Stock",
    locations,
    stock: stock.map((s) => ({
      _id: String(s._id),
      rollId: s.rollId,
      productCode: s.material?.productCode || s.material?.skuCode || "",
      family: s.material?.family || "",
      location: s.location,
      reelMtrs: s.reelMtrs,
      rate: s.rate,
      remarks: s.remarks || "",
      createdAt: s.createdAt,
    })),
    notification: req.flash("notification"),
  });
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const location = String(req.body.location || "").trim();
    const rate = req.body.rate === undefined || req.body.rate === "" ? undefined : Number(req.body.rate);
    const remarks = String(req.body.remarks || "").trim();

    if (!location) return res.status(400).json({ success: false, message: "Location is required." });

    const locationExists = await Location.exists({ locationName: location });
    if (!locationExists) return res.status(400).json({ success: false, message: "Invalid location." });

    const updated = await MaterialStock.findByIdAndUpdate(
      req.params.id,
      { location, rate, remarks: remarks || undefined },
      { new: true, runValidators: true },
    );
    if (!updated) return res.status(404).json({ success: false, message: "Deckle reel not found." });

    res.locals.auditDescription = `Updated semi finished goods (Deckle) reel "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("SEMI FINISHED STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update Deckle reel." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await MaterialStock.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Deckle reel not found." });

    res.locals.auditDescription = `Deleted semi finished goods (Deckle) reel "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("SEMI FINISHED STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete Deckle reel." });
  }
});

export default router;
