import express from "express";
import mongoose from "mongoose";
import Tafeta from "../../models/inventory/tafeta.js";
import TafetaStock from "../../models/inventory/TafetaStock.js";
import TafetaStockLog from "../../models/inventory/TafetaStockLog.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function flex(value) {
  if (!value && value !== 0) return value;
  const values = [value];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== value) values.push(trimmed);
    const numeric = Number(trimmed);
    if (trimmed !== "" && !Number.isNaN(numeric)) values.push(numeric);
  } else {
    values.push(String(value));
  }
  return { $in: values };
}

/* RENDER */
router.get("/", async (req, res) => {
  try {
    const [materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds] =
      await Promise.all([
        Tafeta.distinct("tafetaMaterialCode"),
        Tafeta.distinct("tafetaMaterialType"),
        Tafeta.distinct("tafetaColor"),
        Tafeta.distinct("tafetaGsm"),
        Tafeta.distinct("tafetaWidth"),
        Tafeta.distinct("tafetaMtrs"),
        Tafeta.distinct("tafetaCoreLen"),
        Tafeta.distinct("tafetaNotch"),
        Tafeta.distinct("tafetaCoreId"),
      ]);

    const locations = await Location.distinct("locationName");

    res.render("stock/tafetaStock", {
      title: "Tafeta Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      materialCodes,
      materialTypes,
      colors,
      gsms,
      widths,
      mtrsList,
      coreLens,
      notches,
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
    const {
      tafetaMaterialCode,
      tafetaMaterialType,
      tafetaColor,
      tafetaGsm,
      tafetaWidth,
      tafetaMtrs,
      tafetaCoreLen,
      tafetaNotch,
      tafetaCoreId,
    } = req.query;

    const buildFilter = (excludeKey) => {
      const f = {};
      if (tafetaMaterialCode && excludeKey !== "tafetaMaterialCode") f.tafetaMaterialCode = flex(tafetaMaterialCode);
      if (tafetaMaterialType && excludeKey !== "tafetaMaterialType") f.tafetaMaterialType = flex(tafetaMaterialType);
      if (tafetaColor && excludeKey !== "tafetaColor") f.tafetaColor = flex(tafetaColor);
      if (tafetaGsm && excludeKey !== "tafetaGsm") f.tafetaGsm = flex(tafetaGsm);
      if (tafetaWidth && excludeKey !== "tafetaWidth") f.tafetaWidth = flex(tafetaWidth);
      if (tafetaMtrs && excludeKey !== "tafetaMtrs") f.tafetaMtrs = flex(tafetaMtrs);
      if (tafetaCoreLen && excludeKey !== "tafetaCoreLen") f.tafetaCoreLen = flex(tafetaCoreLen);
      if (tafetaNotch && excludeKey !== "tafetaNotch") f.tafetaNotch = flex(tafetaNotch);
      if (tafetaCoreId && excludeKey !== "tafetaCoreId") f.tafetaCoreId = flex(tafetaCoreId);
      return f;
    };

    const [materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds] =
      await Promise.all([
        Tafeta.distinct("tafetaMaterialCode", buildFilter("tafetaMaterialCode")),
        Tafeta.distinct("tafetaMaterialType", buildFilter("tafetaMaterialType")),
        Tafeta.distinct("tafetaColor", buildFilter("tafetaColor")),
        Tafeta.distinct("tafetaGsm", buildFilter("tafetaGsm")),
        Tafeta.distinct("tafetaWidth", buildFilter("tafetaWidth")),
        Tafeta.distinct("tafetaMtrs", buildFilter("tafetaMtrs")),
        Tafeta.distinct("tafetaCoreLen", buildFilter("tafetaCoreLen")),
        Tafeta.distinct("tafetaNotch", buildFilter("tafetaNotch")),
        Tafeta.distinct("tafetaCoreId", buildFilter("tafetaCoreId")),
      ]);

    res.json({ materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

/* RESOLVE TAFETA */
router.post("/resolve", requireAuth, async (req, res) => {
  try {
    const { materialCode, materialType, color, gsm, width, mtrs, coreLen, notch, coreId } = req.body;

    const tafeta = await Tafeta.findOne({
      tafetaMaterialCode: flex(materialCode?.trim()),
      tafetaMaterialType: flex(materialType?.trim()),
      tafetaColor: flex(color?.trim()),
      tafetaGsm: flex(gsm?.toString().trim()),
      tafetaWidth: flex(width?.toString().trim()),
      tafetaMtrs: flex(mtrs?.toString().trim()),
      tafetaCoreLen: flex(coreLen?.toString().trim()),
      tafetaNotch: flex(notch?.toString().trim()),
      tafetaCoreId: flex(coreId?.toString().trim()),
    }).lean();

    if (!tafeta) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      tafetaId: tafeta._id.toString(),
      TafetaProductId: tafeta.tafetaProductId,
    });
  } catch (err) {
    console.error("Resolve error ❌", err);
    return res.json({ found: false });
  }
});

/* BALANCE */
router.get("/balance/:tafetaId/:location", async (req, res) => {
  try {
    const { tafetaId, location } = req.params;

    if (!mongoose.isValidObjectId(tafetaId)) {
      return res.status(400).json({ error: "Invalid Tafeta ID." });
    }

    const bal = await TafetaStock.aggregate([
      { $match: { tafeta: new mongoose.Types.ObjectId(tafetaId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch stock balance." });
  }
});

router.get("/stock-info/:tafetaId", async (req, res) => {
  try {
    const { tafetaId } = req.params;
    const tafetaObjectId = new mongoose.Types.ObjectId(tafetaId);

    const stockAggregation = await TafetaStock.aggregate([
      { $match: { tafeta: tafetaObjectId } },
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
          onModel: "Tafeta",
          tapeId: tafetaObjectId,
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
    const { tafetaId, location, quantity, remarks } = req.body;
    const qty = Number(quantity);

    // STRONG VALIDATION
    if (!tafetaId || !location || qty <= 0) {
      return res.status(400).json({ success: false, message: "Invalid stock entry" });
    }

    const tafetaObjectId = new mongoose.Types.ObjectId(tafetaId);

    /* CURRENT STOCK */
    const bal = await TafetaStock.aggregate([
      { $match: { tafeta: tafetaObjectId, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    /* INSERT STOCK */
    await TafetaStock.create({
      tafeta: tafetaObjectId,
      location,
      quantity: qty,
      remarks,
    });

    /* LOG ENTRY */
    await TafetaStockLog.create({
      tafeta: tafetaObjectId,
      location,
      openingStock,
      quantity: qty,
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const tafetaDoc = await Tafeta.findById(tafetaObjectId).select("tafetaProductId").lean();
    res.locals.auditDescription = `Added ${qty} Tafeta stock for "${tafetaDoc?.tafetaProductId || tafetaId}" at "${location}"`;
    req.flash("notification", "Tafeta stock added successfully");
    res.redirect("/fairtech/tafetastock");
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add Tafeta stock" });
  }
});

export default router;
