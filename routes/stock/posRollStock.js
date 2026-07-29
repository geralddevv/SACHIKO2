import express from "express";
import mongoose from "mongoose";
import PosRoll from "../../models/inventory/posRoll.js";
import PosRollStock from "../../models/inventory/PosRollStock.js";
import PosRollStockLog from "../../models/inventory/PosRollStockLog.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* RENDER */
router.get("/", async (req, res) => {
  try {
    const [paperCodes, paperTypes, colors, gsms, widths, mtrsList, coreIds] = await Promise.all([
      PosRoll.distinct("posPaperCode"),
      PosRoll.distinct("posPaperType"),
      PosRoll.distinct("posColor"),
      PosRoll.distinct("posGsm"),
      PosRoll.distinct("posWidth"),
      PosRoll.distinct("posMtrs"),
      PosRoll.distinct("posCoreId"),
    ]);

    const locations = await Location.distinct("locationName");

    res.render("stock/posRollStock", {
      title: "POS Roll Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      paperCodes,
      paperTypes,
      colors,
      gsms,
      widths,
      mtrsList,
      coreIds,
      locations,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/fairtech");
  }
});

/* FILTER SPECS */
router.get("/filter-specs", async (req, res) => {
  try {
    const { posPaperCode, posPaperType, posColor, posGsm, posWidth, posMtrs, posCoreId } = req.query;

    const buildFilter = (excludeKey) => {
      const f = {};
      if (posPaperCode && excludeKey !== "posPaperCode") f.posPaperCode = posPaperCode;
      if (posPaperType && excludeKey !== "posPaperType") f.posPaperType = posPaperType;
      if (posColor && excludeKey !== "posColor") f.posColor = posColor;
      if (posGsm && excludeKey !== "posGsm") f.posGsm = Number(posGsm);
      if (posWidth && excludeKey !== "posWidth") {
        const numW = Number(posWidth);
        f.posWidth = !isNaN(numW) ? { $in: [posWidth, numW] } : posWidth;
      }
      if (posMtrs && excludeKey !== "posMtrs") f.posMtrs = Number(posMtrs);
      if (posCoreId && excludeKey !== "posCoreId") f.posCoreId = Number(posCoreId);
      return f;
    };

    const [paperCodes, paperTypes, colors, gsms, widths, mtrsList, coreIds] = await Promise.all([
      PosRoll.distinct("posPaperCode", buildFilter("posPaperCode")),
      PosRoll.distinct("posPaperType", buildFilter("posPaperType")),
      PosRoll.distinct("posColor", buildFilter("posColor")),
      PosRoll.distinct("posGsm", buildFilter("posGsm")),
      PosRoll.distinct("posWidth", buildFilter("posWidth")),
      PosRoll.distinct("posMtrs", buildFilter("posMtrs")),
      PosRoll.distinct("posCoreId", buildFilter("posCoreId")),
    ]);

    res.json({ paperCodes, paperTypes, colors, gsms, widths, mtrsList, coreIds });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

/* RESOLVE POS ROLL */
router.post("/resolve", requireAuth, async (req, res) => {
  try {
    const { paperCode, paperType, color, gsm, width, mtrs, coreId } = req.body;

    const posRoll = await PosRoll.findOne({
      posPaperCode: paperCode?.trim(),
      posPaperType: paperType?.trim(),
      posColor: color?.trim(),
      posGsm: Number(gsm),
      posWidth: !isNaN(Number(width)) ? { $in: [width, Number(width)] } : width,
      posMtrs: Number(mtrs),
      posCoreId: Number(coreId),
    }).lean();

    if (!posRoll) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      posRollId: posRoll._id.toString(),
      PosProductId: posRoll.posProductId,
    });
  } catch (err) {
    console.error("Resolve error ❌", err);
    return res.json({ found: false });
  }
});

/* BALANCE */
router.get("/balance/:posRollId/:location", async (req, res) => {
  try {
    const { posRollId, location } = req.params;

    if (!mongoose.isValidObjectId(posRollId)) {
      return res.status(400).json({ error: "Invalid POS Roll ID." });
    }

    const bal = await PosRollStock.aggregate([
      { $match: { posRoll: new mongoose.Types.ObjectId(posRollId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch stock balance." });
  }
});

router.get("/stock-info/:posRollId", async (req, res) => {
  try {
    const { posRollId } = req.params;
    const posRollObjectId = new mongoose.Types.ObjectId(posRollId);

    const stockAggregation = await PosRollStock.aggregate([
      { $match: { posRoll: posRollObjectId } },
      {
        $group: {
          _id: { location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } } },
          qty: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.location": 1 } },
    ]);

    const bookedAggregation = await TapeSalesOrder.aggregate([
      {
        $match: {
          onModel: "PosRoll",
          tapeId: posRollObjectId,
          status: { $nin: ["CANCELLED"] },
        },
      },
      {
        $group: {
          _id: { location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } } },
          bookedQty: { $sum: { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] } },
        },
      },
    ]);

    const stockMap = Object.fromEntries(
      stockAggregation.map((row) => [String(row._id?.location || "UNKNOWN"), Number(row.qty || 0)]),
    );
    const bookedMap = Object.fromEntries(
      bookedAggregation.map((row) => [String(row._id?.location || "UNKNOWN"), Number(row.bookedQty || 0)]),
    );

    const locations = await Location.distinct("locationName");
    const allLocations = Array.from(
      new Set([
        ...locations.map((location) => String(location || "").trim().toUpperCase()).filter(Boolean),
        ...Object.keys(stockMap),
        ...Object.keys(bookedMap),
      ]),
    ).sort((a, b) => a.localeCompare(b));

    let totalStock = 0;
    let totalBooked = 0;
    const stockInfoLocations = allLocations.map((location) => {
      const qty = Number(stockMap[location] || 0);
      const booked = Number(bookedMap[location] || 0);
      const balance = qty - booked;
      totalStock += qty;
      totalBooked += booked;
      return { location, qty, booked, balance };
    });

    return res.json({
      totalStock,
      booked: totalBooked,
      balance: totalStock - totalBooked,
      locations: stockInfoLocations,
    });
  } catch (err) {
    console.error("Stock info error", err);
    return res.json({ totalStock: 0, booked: 0, balance: 0, locations: [] });
  }
});

/* CREATE (INWARD ONLY) */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { posRollId, location, quantity, remarks } = req.body;
    const qty = Number(quantity);

    // STRONG VALIDATION
    if (!posRollId || !location || qty <= 0) {
      return res.status(400).json({ success: false, message: "Invalid stock entry" });
    }

    const posRollObjectId = new mongoose.Types.ObjectId(posRollId);

    /* CURRENT STOCK */
    const bal = await PosRollStock.aggregate([
      { $match: { posRoll: posRollObjectId, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    /* INSERT STOCK */
    await PosRollStock.create({
      posRoll: posRollObjectId,
      location,
      quantity: qty,
      remarks,
    });

    /* LOG ENTRY */
    await PosRollStockLog.create({
      posRoll: posRollObjectId,
      location,
      openingStock,
      quantity: qty,
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const posRollDoc = await PosRoll.findById(posRollObjectId).select("posProductId").lean();
    res.locals.auditDescription = `Added ${qty} POS Roll stock for "${posRollDoc?.posProductId || posRollId}" at "${location}"`;
    req.flash("notification", "POS Roll stock added successfully");
    res.redirect("/fairtech/posrollstock");
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add POS Roll stock" });
  }
});

export default router;
