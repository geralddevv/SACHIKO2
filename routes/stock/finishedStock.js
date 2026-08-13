import express from "express";
import mongoose from "mongoose";
import FinishedStock from "../../models/inventory/finishedStock.js";
import FinishedStockLog from "../../models/inventory/finishedStockLog.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import MaterialStockLog from "../../models/inventory/materialStockLog.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateFinishedRollId, previewFinishedRollIds } from "../../utils/finishedRollId.js";

const router = express.Router();
const MAX_ROLLS_PER_BATCH = 100;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Finished Goods = rolls slit off a Deckle (MaterialStock) to a specific
// client order's spec. Slitting is always tied to an order -- see
// PendingProduction below -- never a free-standing pick of any Deckle.
router.get("/", async (req, res) => {
  const [locations, stock] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    FinishedStock.find()
      .populate({ path: "material", select: "productCode skuCode" })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  res.render("stock/finishedStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Finished Goods Stock",
    locations,
    stock: stock.map((s) => ({
      _id: String(s._id),
      rollId: s.rollId,
      productCode: s.material?.productCode || s.material?.skuCode || "",
      paperSize: s.paperSize || "",
      lotNo: s.lotNo || "",
      clientName: s.clientName || "",
      location: s.location,
      mtrs: s.mtrs,
      rate: s.rate,
      deckleRollId: s.deckleRollId || "",
      remarks: s.remarks || "",
      createdAt: s.createdAt,
    })),
    notification: req.flash("notification"),
  });
});

// Orders that have at least one allotted Deckle still carrying metres -- the
// "Produce" dialog's order picker. Mirrors buildQueueRows()'s allotted-roll
// resolution in routes/system/machine.js, but only needs the roll balance,
// not the full queue-row shape.
router.get("/eligible-orders", async (req, res) => {
  try {
    const pending = await PendingProduction.find({
      assignedMachineId: { $ne: null },
      allottedRollIds: { $exists: true, $not: { $size: 0 } },
    })
      .populate({ path: "itemId", select: "productCode skuCode" })
      .populate({ path: "userId", select: "clientName userName" })
      .sort({ assignedAt: -1 })
      .lean();

    if (!pending.length) return res.json({ orders: [] });

    const rollIds = pending.flatMap((p) => (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : []));
    const reels = await MaterialStock.find({ _id: { $in: rollIds }, reelMtrs: { $gt: 0 } })
      .select("_id")
      .lean();
    const availableIds = new Set(reels.map((r) => String(r._id)));

    const orders = pending
      .filter((p) => (p.allottedRollIds || []).some((id) => availableIds.has(String(id))))
      .map((p) => ({
        _id: String(p._id),
        lotNo: p.lotNo || "—",
        productCode: p.itemId?.productCode || p.itemId?.skuCode || "—",
        paperSize: p.paperSize || "—",
        noOfRolls: p.noOfRolls ?? null,
        clientName: p.userId?.clientName || p.userId?.userName || "—",
      }));

    res.json({ orders });
  } catch (err) {
    console.error("FINISHED STOCK ELIGIBLE-ORDERS ERROR:", err);
    res.status(500).json({ orders: [] });
  }
});

// Deckles allotted to a given order that still carry metres -- the "Produce"
// dialog's Deckle picker, populated once an order is chosen.
router.get("/order-deckles", async (req, res) => {
  try {
    const pendingId = req.query.pendingId;
    if (!mongoose.isValidObjectId(pendingId)) return res.json({ deckles: [] });

    const pending = await PendingProduction.findById(pendingId).select("allottedRollIds").lean();
    const rollIds = Array.isArray(pending?.allottedRollIds) ? pending.allottedRollIds : [];
    if (!rollIds.length) return res.json({ deckles: [] });

    const deckles = await MaterialStock.find({ _id: { $in: rollIds }, reelMtrs: { $gt: 0 } })
      .select("rollId reelMtrs location rate")
      .sort({ rollId: 1 })
      .lean();

    res.json({
      deckles: deckles.map((d) => ({
        _id: String(d._id),
        rollId: d.rollId,
        reelMtrs: d.reelMtrs,
        location: d.location,
        rate: d.rate,
      })),
    });
  } catch (err) {
    console.error("FINISHED STOCK ORDER-DECKLES ERROR:", err);
    res.status(500).json({ deckles: [] });
  }
});

// Read-only preview of the next `count` Roll IDs -- refreshed by the Produce
// dialog whenever "No of Rolls" changes. Doesn't consume the sequence.
router.get("/preview-roll-ids", async (req, res) => {
  const productCode = String(req.query.productCode || "").trim();
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), MAX_ROLLS_PER_BATCH);
  if (!productCode) return res.json({ rollIds: [] });
  const rollIds = await previewFinishedRollIds(productCode, count);
  res.json({ rollIds });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const pendingId = String(req.body.pendingId || "").trim();
    const deckleStockId = String(req.body.deckleStockId || "").trim();
    if (!mongoose.isValidObjectId(pendingId)) return res.status(400).json({ success: false, message: "Select an order." });
    if (!mongoose.isValidObjectId(deckleStockId)) return res.status(400).json({ success: false, message: "Select a Deckle." });

    const rawRolls = Array.isArray(req.body.rolls) ? req.body.rolls : [];
    if (!rawRolls.length) return res.status(400).json({ success: false, message: "At least one roll is required." });
    if (rawRolls.length > MAX_ROLLS_PER_BATCH) {
      return res.status(400).json({ success: false, message: `A batch can hold at most ${MAX_ROLLS_PER_BATCH} rolls.` });
    }
    const rolls = rawRolls.map((r) => ({ mtrs: Number(r?.mtrs) }));
    const invalidIndex = rolls.findIndex((r) => !r.mtrs || r.mtrs <= 0);
    if (invalidIndex !== -1) {
      return res.status(400).json({ success: false, message: `Mtrs is required for roll ${invalidIndex + 1}.` });
    }

    const pending = await PendingProduction.findById(pendingId)
      .populate("itemId")
      .populate({ path: "userId", select: "clientName userName" });
    if (!pending) return res.status(404).json({ success: false, message: "Order not found." });
    if (!(pending.allottedRollIds || []).some((id) => String(id) === deckleStockId)) {
      return res.status(400).json({ success: false, message: "That Deckle is not allotted to this order." });
    }

    const deckle = await MaterialStock.findById(deckleStockId);
    if (!deckle) return res.status(404).json({ success: false, message: "Deckle reel not found." });

    const totalMtrs = round2(rolls.reduce((sum, r) => sum + r.mtrs, 0));
    if (totalMtrs > Number(deckle.reelMtrs || 0)) {
      return res.status(400).json({
        success: false,
        message: `Deckle "${deckle.rollId}" only has ${deckle.reelMtrs} mtrs left -- needs ${totalMtrs}.`,
      });
    }

    const labelStock = pending.itemId;
    if (!labelStock?.productCode) {
      return res.status(400).json({ success: false, message: "Order's Label Stock SKU is missing a product code." });
    }
    const location = deckle.location;
    const locationExists = await Location.exists({ locationName: location });
    if (!locationExists) return res.status(400).json({ success: false, message: "Invalid location on the Deckle reel." });

    const by = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const clientName = pending.userId?.clientName || pending.userId?.userName || "";

    const createdRollIds = [];
    for (const roll of rolls) {
      const rollId = await generateFinishedRollId(labelStock.productCode);
      await FinishedStock.create({
        pendingProductionId: pending._id,
        material: labelStock._id,
        deckleStockId: deckle._id,
        deckleRollId: deckle.rollId,
        location,
        paperSize: pending.paperSize || "",
        lotNo: pending.lotNo || "",
        clientName,
        quantity: 1,
        mtrs: roll.mtrs,
        rate: deckle.rate,
        rollId,
      });
      createdRollIds.push(rollId);
    }

    // Deduct the slit length off the Deckle, same emptying rule as
    // consumeAllottedRollMeters/produceDeckle.
    const remaining = round2((Number(deckle.reelMtrs) || 0) - totalMtrs);
    const emptied = remaining <= 0;
    await MaterialStock.updateOne(
      { _id: deckle._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

    const matBal = await MaterialStock.aggregate([
      { $match: { material: deckle.material, location: deckle.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = matBal[0]?.qty || 0;
    const rollsOut = emptied ? 1 : 0;

    await MaterialStockLog.create({
      material: deckle.material,
      location: deckle.location,
      openingStock,
      quantity: rollsOut,
      closingStock: openingStock - rollsOut,
      reelMtrs: totalMtrs,
      rate: deckle.rate,
      rollId: deckle.rollId,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `Slit into ${createdRollIds.length} finished roll(s): ${createdRollIds.join(", ")}${emptied ? " — reel emptied" : ""}`,
      createdBy: by,
    });

    const finBal = await FinishedStock.aggregate([
      { $match: { material: labelStock._id, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    let finOpening = (finBal[0]?.qty || 0) - createdRollIds.length;
    for (const rollId of createdRollIds) {
      finOpening += 1;
      await FinishedStockLog.create({
        material: labelStock._id,
        location,
        openingStock: finOpening - 1,
        quantity: 1,
        closingStock: finOpening,
        rollId,
        type: "INWARD",
        source: "MANUAL",
        remarks: `Slit from Deckle ${deckle.rollId}`,
        createdBy: by,
      });
    }

    res.locals.auditDescription = `Slit Deckle "${deckle.rollId}" into ${createdRollIds.length} finished roll(s) for order ${pending.lotNo || pending._id}: ${createdRollIds.join(", ")}`;
    req.flash("notification", `${createdRollIds.length} finished roll(s) created successfully!`);
    res.json({ success: true, redirect: "/sachiko/finishedstock" });
  } catch (err) {
    console.error("FINISHED STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to produce finished rolls.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const location = String(req.body.location || "").trim();
    const rate = req.body.rate === undefined || req.body.rate === "" ? undefined : Number(req.body.rate);
    const remarks = String(req.body.remarks || "").trim();

    if (!location) return res.status(400).json({ success: false, message: "Location is required." });
    const locationExists = await Location.exists({ locationName: location });
    if (!locationExists) return res.status(400).json({ success: false, message: "Invalid location." });

    const updated = await FinishedStock.findByIdAndUpdate(
      req.params.id,
      { location, rate, remarks: remarks || undefined },
      { new: true, runValidators: true },
    );
    if (!updated) return res.status(404).json({ success: false, message: "Finished roll not found." });

    res.locals.auditDescription = `Updated finished roll "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FINISHED STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update finished roll." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await FinishedStock.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Finished roll not found." });

    res.locals.auditDescription = `Deleted finished roll "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FINISHED STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete finished roll." });
  }
});

export default router;
