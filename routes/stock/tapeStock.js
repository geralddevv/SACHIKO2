import express from "express";
import mongoose from "mongoose";
import Tape from "../../models/inventory/tape.js";
import TapeStock from "../../models/inventory/TapeStock.js";
import TapeStockLog from "../../models/inventory/TapeStockLog.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* RENDER */
router.get("/", async (req, res) => {
  try {
    const [paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Tape.distinct("tapePaperCode"),
      Tape.distinct("tapePaperType"),
      Tape.distinct("tapeGsm"),
      Tape.distinct("tapeWidth"),
      Tape.distinct("tapeMtrs"),
      Tape.distinct("tapeCoreId"),
      Tape.distinct("tapeFinish"),
    ]);

    const locations = await Location.distinct("locationName");

    res.render("stock/tapeStock", {
      title: "Tape Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      paperCodes,
      paperTypes,
      gsms,
      widths,
      mtrsList,
      coreIds,
      finishes,
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
    const { tapePaperCode, tapePaperType, tapeGsm, tapeWidth, tapeMtrs, tapeCoreId, tapeFinish } = req.query;

    // Helper to build filter excluding one key so user can change selection
    const buildFilter = (excludeKey) => {
      const f = {};
      if (tapePaperCode && excludeKey !== "tapePaperCode") f.tapePaperCode = tapePaperCode;
      if (tapePaperType && excludeKey !== "tapePaperType") f.tapePaperType = tapePaperType;
      if (tapeGsm && excludeKey !== "tapeGsm") f.tapeGsm = Number(tapeGsm);
      if (tapeWidth && excludeKey !== "tapeWidth") {
        const numW = Number(tapeWidth);
        f.tapeWidth = !isNaN(numW) ? { $in: [tapeWidth, numW] } : tapeWidth;
      }
      if (tapeMtrs && excludeKey !== "tapeMtrs") f.tapeMtrs = Number(tapeMtrs);
      if (tapeCoreId && excludeKey !== "tapeCoreId") f.tapeCoreId = Number(tapeCoreId);
      if (tapeFinish && excludeKey !== "tapeFinish") f.tapeFinish = tapeFinish;
      return f;
    };

    const [paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Tape.distinct("tapePaperCode", buildFilter("tapePaperCode")),
      Tape.distinct("tapePaperType", buildFilter("tapePaperType")),
      Tape.distinct("tapeGsm", buildFilter("tapeGsm")),
      Tape.distinct("tapeWidth", buildFilter("tapeWidth")),
      Tape.distinct("tapeMtrs", buildFilter("tapeMtrs")),
      Tape.distinct("tapeCoreId", buildFilter("tapeCoreId")),
      Tape.distinct("tapeFinish", buildFilter("tapeFinish")),
    ]);

    res.json({ paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

/* RESOLVE TAPE */
router.post("/resolve", requireAuth, async (req, res) => {
  try {
    const { paperCode, gsm, paperType, width, mtrs, coreId, finish } = req.body;

    const widthFilter = !isNaN(Number(width)) ? { $in: [width, Number(width)] } : width;
    const tape = await Tape.findOne({
      tapePaperCode: paperCode?.trim(),
      tapeGsm: Number(gsm),
      tapePaperType: paperType?.trim(),
      tapeWidth: widthFilter,
      tapeMtrs: Number(mtrs),
      tapeCoreId: Number(coreId),
      tapeFinish: finish,
    }).lean();

    if (!tape) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      tapeId: tape._id.toString(),
      TapeProductId: tape.tapeProductId,
    });
  } catch (err) {
    console.error("Resolve error ❌", err);
    return res.json({ found: false });
  }
});

/* BALANCE */
router.get("/balance/:tapeId/:location", async (req, res) => {
  try {
    const { tapeId, location } = req.params;

    if (!mongoose.isValidObjectId(tapeId)) {
      return res.status(400).json({ error: "Invalid tape ID." });
    }

    const bal = await TapeStock.aggregate([
      { $match: { tape: new mongoose.Types.ObjectId(tapeId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch stock balance." });
  }
});

router.get("/stock-info/:tapeId", async (req, res) => {
  try {
    const { tapeId } = req.params;
    const tapeObjectId = new mongoose.Types.ObjectId(tapeId);

    const stockAggregation = await TapeStock.aggregate([
      { $match: { tape: tapeObjectId } },
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
          onModel: "Tape",
          tapeId: tapeObjectId,
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
    const { tapeId, tapeFinish, location, quantity, remarks } = req.body;
    const qty = Number(quantity);

    // STRONG VALIDATION
    if (!tapeId || !tapeFinish || !location || qty <= 0) {
      return res.status(400).json({ success: false, message: "Invalid stock entry" });
    }

    const tapeObjectId = new mongoose.Types.ObjectId(tapeId);

    /* CURRENT STOCK */
    const bal = await TapeStock.aggregate([
      { $match: { tape: tapeObjectId, location, tapeFinish } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    /* INSERT STOCK */
    await TapeStock.create({
      tape: tapeObjectId,
      tapeFinish, // REQUIRED FIELD FIXED
      location,
      quantity: qty,
      remarks,
    });

    /* LOG ENTRY */
    await TapeStockLog.create({
      tape: tapeObjectId,
      tapeFinish, // KEEP LOG CONSISTENT
      location,
      openingStock,
      quantity: qty,
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const tapeDoc = await Tape.findById(tapeObjectId).select("tapeProductId").lean();
    res.locals.auditDescription = `Added ${qty} tape stock for "${tapeDoc?.tapeProductId || tapeId}" at "${location}" (finish ${tapeFinish})`;
    req.flash("notification", "Tape stock added successfully");
    res.redirect("/fairtech/tapestock");
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add tape stock" });
  }
});

export default router;
