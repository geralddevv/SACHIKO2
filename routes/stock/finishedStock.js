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

// ---- Export to FAIRTECH ------------------------------------------------->
// The mirror of FAIRTECH's own paper re-order export (its
// routes/inventory/paperReorder.js -> our /sales/pending import): the two apps
// are separate deployments on separate databases, so the file IS the whole
// interface and everything has to be re-resolved on the way in.
//
// Going this way, a finished roll here becomes a reel of paper stock there:
//   productCode -> Paper.prodCode   (the string both masters already share)
//   family      -> Paper.family     (with vendorName, what identifies the paper)
//   paperSize   -> PaperStock.paperSize
//   mtrs        -> PaperStock.paperMtrs
//   rate        -> PaperStock.rate  (what we sold it at = what they bought at)
//   rollId      -> PaperStock.vendorRollId (FAIRTECH mints its own rollId)
//
// Every one of those is REQUIRED on their side, so each is validated here
// rather than letting the import fail halfway through a delivery.
const FAIRTECH_VENDOR_NAME = (process.env.FAIRTECH_VENDOR_NAME || "SACHIKO PACKAGING").trim().toUpperCase();
const FAIRTECH_CLIENT_NAME = (process.env.FAIRTECH_CLIENT_NAME || "FAIRTECH SYSTEMS").trim();
const FAIRTECH_EXPORT_FORMAT = "sachiko.finished-stock.fairtech-paper-inward";
const FAIRTECH_EXPORT_VERSION = 1;
const MAX_ROLLS_PER_EXPORT = 500;

// A finished roll is booked against the Deckle's OWN Label Stock, so its code
// can be a production-time VARIANT ("C001WB-B" -- utils/labelStockVariant.js).
// That split is internal to this app: FAIRTECH files the paper under the base
// code ("C001WB") and knows nothing about variants, so exporting the variant
// verbatim would miss the existing Paper there and mint a junk duplicate. The
// full code still travels, as variantProductCode, purely for tracing a reel
// back here. Same base-code rule productCodeBase() applies in slitting.js.
const baseProductCode = (code) => {
  const c = String(code || "").trim();
  if (!c) return "";
  return /^(.*[^-])-[A-Z]+$/.exec(c)?.[1] || c;
};

// Exporting DISPATCHES the rolls: they physically leave for FAIRTECH, so they
// come off this stock at the same moment the file is made, or the same reels
// would be counted in both databases at once. Nothing is deleted -- the roll
// keeps its row and its whole INWARD/OUTWARD history (quantity 0 is exactly
// how an emptied reel is recorded everywhere else here).
router.post("/export", requireAuth, createLimiter, async (req, res) => {
  const fail = (message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const invoiceNo = String(req.body?.invoiceNo || "").trim();
    const dispatchDate = String(req.body?.dispatchDate || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    if (!ids.length) return fail("Tick at least one roll to export.");
    if (ids.length > MAX_ROLLS_PER_EXPORT) {
      return fail(`Too many rolls at once — export up to ${MAX_ROLLS_PER_EXPORT} in one go.`);
    }
    if (ids.some((id) => !mongoose.isValidObjectId(id))) return fail("One of the selected rolls is invalid — reload the page.");
    // Both are required on a FAIRTECH PaperStock reel, so a blank one here
    // would only surface as a failure on their side, mid-import.
    if (!invoiceNo) return fail("Enter the invoice number this delivery goes out on.");
    if (!dispatchDate) return fail("Enter the dispatch date.");

    const rolls = await FinishedStock.find({ _id: { $in: ids } })
      .populate({ path: "material", select: "productCode skuCode family" })
      .lean();
    if (rolls.length !== ids.length) return fail("Some selected rolls no longer exist — reload the page.");

    // Validate the WHOLE selection before anything moves: a delivery either
    // goes out complete or not at all, and a half-exported selection would
    // leave the two apps disagreeing about what shipped.
    const problems = [];
    for (const r of rolls) {
      const label = r.rollId || String(r._id);
      const productCode = baseProductCode(r.material?.productCode || r.material?.skuCode);
      const family = String(r.material?.family || "").trim();
      const size = Number(r.paperSize);
      if (!(Number(r.quantity) > 0)) problems.push(`${label} is not in stock any more (already exported or dispatched).`);
      else if (!productCode) problems.push(`${label} has no Product Code — FAIRTECH matches paper on it.`);
      else if (!family) problems.push(`${label} has no Family on its Label Stock — FAIRTECH needs it to file the paper.`);
      else if (!(size > 0)) problems.push(`${label} has no usable Paper Size ("${r.paperSize ?? ""}").`);
      else if (!(Number(r.mtrs) > 0)) problems.push(`${label} has no metres on it.`);
      else if (!(Number(r.rate) > 0)) problems.push(`${label} has no Rate — FAIRTECH books every reel in at a rate.`);
    }
    if (problems.length) {
      return fail(`${problems.length} roll(s) can't be exported.`, { problems });
    }

    // Claim each roll atomically -- quantity > 0 is the guard, so two people
    // exporting the same roll at once can't both take it, and a double-click
    // can't dispatch it twice.
    const dispatchedAt = new Date();
    const claimed = [];
    for (const r of rolls) {
      const result = await FinishedStock.updateOne(
        { _id: r._id, quantity: { $gt: 0 } },
        { $set: { quantity: 0, dispatchedAt, dispatchInvoiceNo: invoiceNo } },
      );
      if (result.modifiedCount === 1) claimed.push(r);
      else break;
    }
    if (claimed.length !== rolls.length) {
      // Someone else got in first. Put back whatever this request took so the
      // selection is left exactly as it was found.
      for (const r of claimed) {
        await FinishedStock.updateOne(
          { _id: r._id },
          { $set: { quantity: r.quantity }, $unset: { dispatchedAt: "", dispatchInvoiceNo: "" } },
        );
      }
      return fail("Another user exported one of these rolls just now — reload the page and try again.");
    }

    const by = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";

    // One OUTWARD line per roll, per location, opening/closing tracked the
    // same way the INWARD lines above do it.
    const openingByLocation = new Map();
    for (const r of claimed) {
      const key = `${String(r.material?._id || r.material)}|${r.location}`;
      if (!openingByLocation.has(key)) {
        const bal = await FinishedStock.aggregate([
          { $match: { material: new mongoose.Types.ObjectId(String(r.material?._id || r.material)), location: r.location } },
          { $group: { _id: null, qty: { $sum: "$quantity" } } },
        ]);
        // The claims above already landed, so add them back to recover the
        // balance as it stood before this export.
        const taken = claimed.filter((c) => `${String(c.material?._id || c.material)}|${c.location}` === key).length;
        openingByLocation.set(key, (bal[0]?.qty || 0) + taken);
      }
      const opening = openingByLocation.get(key);
      await FinishedStockLog.create({
        material: r.material?._id || r.material,
        location: r.location,
        openingStock: opening,
        quantity: 1,
        closingStock: opening - 1,
        mtrs: r.mtrs,
        rate: r.rate,
        rollId: r.rollId,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `Exported to FAIRTECH paper stock on invoice ${invoiceNo}${remarks ? ` — ${remarks}` : ""}`,
        createdBy: by,
      });
      openingByLocation.set(key, opening - 1);
    }

    const payload = {
      format: FAIRTECH_EXPORT_FORMAT,
      version: FAIRTECH_EXPORT_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        app: "SACHIKO",
        page: "/sachiko/finishedstock",
        exportedBy: by,
      },
      dispatch: {
        vendorName: FAIRTECH_VENDOR_NAME,
        clientName: FAIRTECH_CLIENT_NAME,
        invoiceNo,
        dispatchDate,
        remarks,
      },
      lines: claimed.map((r) => ({
        rollId: r.rollId,
        // What FAIRTECH matches its Paper on -- the base code, never the
        // internal "-A"/"-B" variant (see baseProductCode above).
        productCode: baseProductCode(r.material?.productCode || r.material?.skuCode),
        variantProductCode: String(r.material?.productCode || r.material?.skuCode || "").trim(),
        family: String(r.material?.family || "").trim(),
        paperSize: Number(r.paperSize),
        mtrs: round2(Number(r.mtrs)),
        rate: Number(r.rate),
        lotNo: r.lotNo || "",
      })),
    };

    const fileName = `sachiko-finished-stock-${invoiceNo.replace(/[^A-Za-z0-9]+/g, "-")}.json`;
    res.locals.auditDescription =
      `Exported ${claimed.length} finished roll(s) to FAIRTECH on invoice ${invoiceNo}: ${claimed.map((r) => r.rollId).join(", ")}`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("FINISHED STOCK EXPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to build the export file." });
  }
});
// <---------------------------------------- Export to FAIRTECH -------------

// Finished Goods = rolls slit off a Deckle (MaterialStock) to a specific
// client order's spec. Slitting is always tied to an order -- see
// PendingProduction below -- never a free-standing pick of any Deckle.
router.get("/", async (req, res) => {
  const [locations, stock] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    // Stock only. A roll dispatched to FAIRTECH keeps its row and its whole
    // ledger history, but it has physically left -- it belongs on the
    // Dispatched page below, not in a list of what is on the floor.
    FinishedStock.find({ quantity: { $gt: 0 } })
      .populate({ path: "material", select: "productCode skuCode family" })
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
      family: s.material?.family || "",
      // 0 once the roll has gone out (exported to FAIRTECH, see POST /export).
      // The row and its whole ledger history stay -- this is what tells the
      // page it is no longer stock rather than deleting the record.
      quantity: Number(s.quantity) || 0,
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

// Rolls that have left for FAIRTECH. Kept out of the stock list above -- they
// are not on the floor any more -- but kept in full here, with the invoice
// they went out on, so the history of what was dispatched stays readable.
// Declared ahead of any "/:id" route: Express matches in declaration order.
router.get("/dispatched", async (req, res) => {
  const stock = await FinishedStock.find({ quantity: { $lte: 0 } })
    .populate({ path: "material", select: "productCode skuCode family" })
    .sort({ dispatchedAt: -1, updatedAt: -1 })
    .lean();

  res.render("stock/finishedStockDispatched.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Dispatched Finished Goods",
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
      invoiceNo: s.dispatchInvoiceNo || "",
      // Rolls dispatched before these fields existed have no stamp of their
      // own; fall back to when the row was last written rather than showing
      // nothing at all.
      dispatchedAt: s.dispatchedAt || s.updatedAt || null,
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
    res.json({ success: true, redirect: "/app/finishedstock" });
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
