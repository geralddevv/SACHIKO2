import express from "express";
import Tape from "../../models/inventory/tape.js";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import VendorTapeBinding from "../../models/inventory/vendorTapeBinding.js";
import TapeStock from "../../models/inventory/TapeStock.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { getUserLocationNames } from "../../utils/locations.js";

const router = express.Router();

/* GET : Load Tape Binding Form */
router.get("/form/tape-binding", async (req, res) => {
  try {
    const [clients, paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Client.distinct("clientName"),
      Tape.distinct("tapePaperCode"),
      Tape.distinct("tapePaperType"),
      Tape.distinct("tapeGsm"),
      Tape.distinct("tapeWidth"),
      Tape.distinct("tapeMtrs"),
      Tape.distinct("tapeCoreId"),
      Tape.distinct("tapeFinish"),
    ]);

    // console.log(paperCodes, paperTypes, gsms, widths, mtrsList);

    res.render("inventory/tape/tapeBinding.ejs", {
      title: "Client Tape",
      clients,
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
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Tape Binding");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Save Tape Binding */
router.post("/form/tape-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, tapeId } = req.body;
    const location = String(req.body.location || "").trim();

    // Validate user exists
    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }

    // Check for duplicate binding — same user, tape master, client paper code, GSM, item type, and location
    const existingBinding = await TapeBinding.exists({
      userId,
      tapeId,
      tapeClientPaperCode: String(req.body.tapeClientPaperCode || "").trim(),
      clientTapeGsm: Number(req.body.clientTapeGsm),
      itemClientItemType: String(req.body.itemClientItemType || "").trim(),
      location,
    });
    if (existingBinding) {
      return res.status(400).json({ success: false, message: "A binding with this tape, client paper code, GSM, item type, and location already exists for this user." });
    }

    // Create tape binding with user reference
    const tapeBinding = await TapeBinding.create({
      tapeClientPaperCode: String(req.body.tapeClientPaperCode || "").trim(),
      clientTapeGsm: Number(req.body.clientTapeGsm),
      itemClientItemType: String(req.body.itemClientItemType || "").trim(),
      tapeRatePerRoll: Number(req.body.tapeRatePerRoll),
      tapeSaleCost: Number(req.body.tapeSaleCost),
      tapeMinQty: Number(req.body.tapeMinQty),
      tapeOdrQty: Number(req.body.tapeOdrQty),
      tapeMtrsDel: Number(req.body.tapeMtrsDel || 0),
      userId,
      tapeId,
      location,
    });

    // Attach tapeBinding to user (like label/ttr)
    user.tape.push(tapeBinding._id);
    await user.save();

    res.locals.auditDescription = `Created tape binding "${tapeBinding.tapeClientPaperCode}" for "${user.userName}"`;
    req.flash("notification", "Tape binding created successfully!");
    res.json({ success: true, redirect: "/fairtech/client/details/" + userId });
  } catch (err) {
    console.error("TAPE BINDING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create tape binding." });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/tape-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");

    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter Tape Specs (cascading smart form) */
router.get("/form/tape-binding/filter-specs", async (req, res) => {
  try {
    const { tapePaperCode, tapePaperType, tapeGsm, tapeWidth, tapeMtrs, tapeCoreId, tapeFinish } = req.query;

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    // Helper to build filter excluding one key so user can change selection
    const buildFilter = (excludeKey) => {
      const f = {};
      if (tapePaperCode && excludeKey !== "tapePaperCode") f.tapePaperCode = flex(tapePaperCode);
      if (tapePaperType && excludeKey !== "tapePaperType") f.tapePaperType = flex(tapePaperType);
      if (tapeGsm && excludeKey !== "tapeGsm") f.tapeGsm = flex(tapeGsm);
      if (tapeWidth && excludeKey !== "tapeWidth") f.tapeWidth = flex(tapeWidth);
      if (tapeMtrs && excludeKey !== "tapeMtrs") f.tapeMtrs = flex(tapeMtrs);
      if (tapeCoreId && excludeKey !== "tapeCoreId") f.tapeCoreId = flex(tapeCoreId);
      if (tapeFinish && excludeKey !== "tapeFinish") f.tapeFinish = flex(tapeFinish);
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
    console.error("FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve Tape from Specifications */
router.get("/form/tape-binding/resolve-tape", async (req, res) => {
  try {
    const { tapePaperCode, tapePaperType, tapeGsm, tapeWidth, tapeMtrs, tapeCoreId, tapeFinish } = req.query;

    if (!tapePaperCode || !tapePaperType || !tapeGsm || !tapeWidth || !tapeMtrs || !tapeCoreId || !tapeFinish) {
      return res.status(400).json(null);
    }

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    const tape = await Tape.findOne({
      tapePaperCode: flex(tapePaperCode),
      tapePaperType: flex(tapePaperType),
      tapeGsm: flex(tapeGsm),
      tapeWidth: flex(tapeWidth),
      tapeMtrs: flex(tapeMtrs),
      tapeCoreId: flex(tapeCoreId),
      tapeFinish: flex(tapeFinish),
    }).lean();

    if (!tape) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      tapeId: tape._id,
      tapeProductId: tape.tapeProductId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Display Bound Tapes */
router.get("/tape/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({
        path: "tape",
        populate: [
          { path: "tapeId", model: "Tape" }, // Tape Master
          { path: "userId", model: "Username" }, // User ref
        ],
      })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    // Fetch stock for all bound tapes in one aggregation to avoid N+1 queries
    const tapeData = user.tape || [];
    const tapeIds = tapeData.map((binding) => binding.tapeId?._id).filter(Boolean);

    const stockMap = {};
    if (tapeIds.length) {
      const stockAgg = await TapeStock.aggregate([
        { $match: { tape: { $in: tapeIds } } },
        { $group: { _id: "$tape", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }

    tapeData.forEach((binding) => {
      const tid = binding.tapeId?._id?.toString();
      binding.stock = stockMap[tid] || 0;
    });

    res.render("inventory/tape/tapeDisp.ejs", {
      jsonData: tapeData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Tape Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE VIEW ERROR:", err);
    res.redirect(req.get("Referrer") || "/");
  }
});

/* GET : All client bindings for a tape master */
router.get("/tape/master-view/clients/:tapeId", async (req, res) => {
  try {
    const tape = await Tape.findById(req.params.tapeId).lean();
    if (!tape) {
      req.flash("notification", "Tape master not found");
      return res.redirect("back");
    }

    const bindings = await TapeBinding.find({ tapeId: req.params.tapeId })
      .populate({ path: "tapeId", model: "Tape" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    const stockAgg = await TapeStock.aggregate([
      { $match: { tape: tape._id } },
      { $group: { _id: "$tape", total: { $sum: "$quantity" } } },
    ]);
    const stock = stockAgg[0]?.total || 0;
    bindings.forEach((b) => { b.stock = stock; });

    res.render("inventory/tape/tapeDisp.ejs", {
      jsonData: bindings,
      CSS: "tableDisp.css",
      JS: false,
      title: `Clients bound to ${tape.tapeProductId}`,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE MASTER CLIENTS VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : All vendor bindings for a tape master */
router.get("/tape/master-view/vendors/:tapeId", async (req, res) => {
  try {
    const tape = await Tape.findById(req.params.tapeId).lean();
    if (!tape) {
      req.flash("notification", "Tape master not found");
      return res.redirect("back");
    }

    const bindings = await VendorTapeBinding.find({ tapeId: req.params.tapeId })
      .populate("vendorUserId")
      .populate("tapeId")
      .lean();

    const stockAgg = await TapeStock.aggregate([
      { $match: { tape: tape._id } },
      { $group: { _id: "$tape", total: { $sum: "$quantity" } } },
    ]);
    const stock = stockAgg[0]?.total || 0;

    const jsonData = bindings.map((binding) => ({
      ...binding,
      stock,
      displayValue: binding.tapeId?.tapeProductId || "",
      vendorName: binding.vendorUserId?.vendorName || "",
      userName: binding.vendorUserId?.userName || "",
      userContact: binding.vendorUserId?.userContact || "",
    }));

    res.render("inventory/tape/tapeVendorDisp.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: `Vendors bound to ${tape.tapeProductId}`,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE MASTER VENDORS VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : Compare Client Tape vs Master */
router.get("/tape/compare/:id", async (req, res) => {
  try {
    const binding = await TapeBinding.findById(req.params.id)
      .populate({ path: "tapeId", model: "Tape" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const tape = binding.tapeId || {};
    const user = binding.userId || {};
    const vendorBinding = tape._id
      ? await VendorTapeBinding.findOne({ tapeId: tape._id }).populate({ path: "vendorUserId", model: "VendorUser" }).lean()
      : null;
    const vb = vendorBinding || {};

    const compareRows = [
      { field: "Paper Code", vendorValue: vb.vendorTapePaperCode || "-", orgValue: tape.tapePaperCode || "N/A", clientValue: binding.tapeClientPaperCode || "N/A" },
      { field: "GSM", vendorValue: vb.vendorTapeGsm ?? "-", orgValue: tape.tapeGsm ?? "N/A", clientValue: binding.clientTapeGsm ?? "N/A" },
      { field: "Paper Type", vendorValue: vb.vendorTapePaperType || "-", orgValue: tape.tapePaperType || "N/A", clientValue: tape.tapePaperType || "N/A" },
      // Width/Meters/Core ID/Finish/Adhesive GSM are fixed physical specs of
      // the Tape master itself (VendorTapeBinding has no per-vendor fields for
      // these — only paper code/gsm/type vary by vendor), so the vendor's
      // value is the same master spec it's supplying, not "-".
      { field: "Width", vendorValue: tape.tapeWidth ?? "-", orgValue: tape.tapeWidth ?? "N/A", clientValue: tape.tapeWidth ?? "N/A" },
      { field: "Meters", vendorValue: tape.tapeMtrs ?? "-", orgValue: tape.tapeMtrs ?? "N/A", clientValue: tape.tapeMtrs ?? "N/A" },
      { field: "Core ID", vendorValue: tape.tapeCoreId ?? "-", orgValue: tape.tapeCoreId ?? "N/A", clientValue: tape.tapeCoreId ?? "N/A" },
      { field: "Finish", vendorValue: tape.tapeFinish || "-", orgValue: tape.tapeFinish || "N/A", clientValue: tape.tapeFinish || "N/A" },
      { field: "Adhesive GSM", vendorValue: tape.tapeAdhesiveGsm || "-", orgValue: tape.tapeAdhesiveGsm || "N/A", clientValue: tape.tapeAdhesiveGsm || "N/A" },
      { field: "Minimum Qty", vendorValue: vb.tapeMinQty ?? "-", orgValue: "-", clientValue: binding.tapeMinQty ?? "N/A" },
      { field: "Order Qty", vendorValue: vb.tapeOdrQty ?? "-", orgValue: "-", clientValue: binding.tapeOdrQty ?? "N/A" },
      { field: "Order Frequency", vendorValue: vb.tapeOdrFreq || "-", orgValue: "-", clientValue: binding.tapeOdrFreq || "N/A" },
      { field: "Credit Term", vendorValue: vb.tapeCreditTerm || "-", orgValue: "-", clientValue: binding.tapeCreditTerm || "N/A" },
      { field: "Rate Per Roll", vendorValue: vb.tapeRatePerRoll ?? "-", orgValue: "-", clientValue: binding.tapeRatePerRoll ?? "N/A" },
      { field: "Sale Cost", vendorValue: vb.tapeSaleCost ?? "-", orgValue: "-", clientValue: binding.tapeSaleCost ?? "N/A" },
      { field: "Meters Delivered", vendorValue: vb.tapeMtrsDel ?? "-", orgValue: "-", clientValue: binding.tapeMtrsDel ?? 0 },
      { field: "Status", vendorValue: vb.status || "-", orgValue: "-", clientValue: binding.status || "N/A" },
    ];

    res.render("inventory/itemCompare.ejs", {
      title: "Tape Compare",
      CSS: false,
      JS: false,
      itemTitle: "Tape Details",
      sectionTitle: "Tape Details (Vendor - Fairtech - Client)",
      vendorLabel: "Vendor",
      orgLabel: "Fairtech",
      clientLabel: "Client",
      editBindingUrl: `/fairtech/tape-binding/edit/${binding._id}`,
      clientName: user?.clientName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE COMPARE ERROR:", err);
    req.flash("notification", "Failed to load Tape comparison");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* GET : Load Tape Binding Edit Form */
router.get("/tape-binding/edit/:id", async (req, res) => {
  try {
    const binding = await TapeBinding.findById(req.params.id).populate("tapeId").populate("userId");

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const [paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Tape.distinct("tapePaperCode"),
      Tape.distinct("tapePaperType"),
      Tape.distinct("tapeGsm"),
      Tape.distinct("tapeWidth"),
      Tape.distinct("tapeMtrs"),
      Tape.distinct("tapeCoreId"),
      Tape.distinct("tapeFinish"),
    ]);

    res.render("inventory/tape/tapeBindingEdit.ejs", {
      title: "Edit Tape Binding",
      binding,
      userLocations: getUserLocationNames(binding.userId, binding.location),
      paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("EDIT BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load Tape Binding Edit");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Update Tape Binding */
router.post("/tape-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tapeId: newTapeId,
      tapeClientPaperCode,
      clientTapeGsm,
      tapeMtrsDel,
      tapeRatePerRoll,
      tapeSaleCost,
      tapeMinQty,
      tapeOdrQty,
      tapeOdrFreq,
      tapeCreditTerm,
      billingType,
      status,
      returnTo,
      itemClientItemType,
    } = req.body;

    const binding = await TapeBinding.findById(id);
    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    // Location is now selectable on edit; keep the existing one if none sent.
    const location = String(req.body.location || "").trim() || binding.location;
    if (!location) {
      req.flash("notification", "Please select a location");
      return res.redirect(req.get("Referrer") || "/");
    }

    const duplicate = await TapeBinding.exists({
      _id: { $ne: id },
      userId: binding.userId,
      tapeId: binding.tapeId,
      tapeClientPaperCode: String(tapeClientPaperCode || "").trim(),
      clientTapeGsm: Number(clientTapeGsm),
      itemClientItemType: String(itemClientItemType || "").trim(),
      location,
    });
    if (duplicate) {
      req.flash("notification", "A binding with this tape, client paper code, GSM, and item type already exists for this user.");
      return res.redirect(req.get("Referrer") || "/");
    }

    if (newTapeId && /^[a-f\d]{24}$/i.test(newTapeId)) binding.tapeId = newTapeId;
    binding.tapeClientPaperCode = tapeClientPaperCode;
    binding.clientTapeGsm = Number(clientTapeGsm);
    binding.tapeMtrsDel = Number(tapeMtrsDel);
    binding.tapeRatePerRoll = Number(tapeRatePerRoll);
    binding.tapeSaleCost = Number(tapeSaleCost);
    binding.tapeMinQty = Number(tapeMinQty);
    binding.tapeOdrQty = Number(tapeOdrQty);
    binding.tapeOdrFreq = tapeOdrFreq;
    binding.tapeCreditTerm = tapeCreditTerm;
    if (billingType) {
      binding.billingType = billingType;
    }

    if (status) {
      binding.status = status;
    }

    binding.itemClientItemType = itemClientItemType;
    binding.location = location;
    await binding.save();

    res.locals.auditDescription = `Updated tape binding "${binding.tapeClientPaperCode}"`;
    req.flash("notification", "Tape binding updated successfully!");

    if (typeof returnTo === "string" && returnTo.startsWith("/fairtech/")) {
      return res.redirect(returnTo);
    }

    res.redirect("/fairtech/tape/view/" + binding.userId);
  } catch (err) {
    console.error("EDIT BINDING POST ERROR:", err);
    if (err.code === 11000) {
      req.flash("notification", "A tape binding with this exact configuration already exists.");
    } else {
      req.flash("notification", "Failed to update Tape Binding");
    }
    res.redirect(req.get("Referrer") || "/");
  }
});

router.post("/tape-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await TapeBinding.findById(id).select("userId tapeClientPaperCode").lean();

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    await TapeBinding.deleteOne({ _id: id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { tape: id } });

    res.locals.auditDescription = `Deleted tape binding "${binding.tapeClientPaperCode}"`;
    req.flash("notification", "Tape binding removed successfully!");
    return res.redirect(`/fairtech/tape/view/${binding.userId}`);
  } catch (err) {
    console.error("TAPE BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Tape binding");
    return res.redirect("back");
  }
});

router.post("/tape-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await TapeBinding.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set tape binding "${binding.tapeClientPaperCode}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("TAPE SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

router.post("/tape-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await TapeBinding.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set tape binding "${binding.tapeClientPaperCode}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("TAPE SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

export default router;
