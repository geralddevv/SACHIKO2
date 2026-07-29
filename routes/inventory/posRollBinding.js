import express from "express";
import PosRoll from "../../models/inventory/posRoll.js";
import PosRollBinding from "../../models/inventory/posRollBinding.js";
import VendorPosRollBinding from "../../models/inventory/vendorPosRollBinding.js";
import PosRollStock from "../../models/inventory/PosRollStock.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { getUserLocationNames } from "../../utils/locations.js";

const router = express.Router();

/* GET : Load POS Roll Binding Form */
router.get("/form/pos-roll-binding", async (req, res) => {
  try {
    const [clients, paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, colors] = await Promise.all([
      Client.distinct("clientName"),
      PosRoll.distinct("posPaperCode"),
      PosRoll.distinct("posPaperType"),
      PosRoll.distinct("posGsm"),
      PosRoll.distinct("posWidth"),
      PosRoll.distinct("posMtrs"),
      PosRoll.distinct("posCoreId"),
      PosRoll.distinct("posColor"),
    ]);

    res.render("inventory/posRoll/posRollBinding.ejs", {
      title: "Client POS Roll",
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
      colors,
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load POS Roll Binding");
    res.redirect("back");
  }
});

router.post("/form/pos-roll-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, posRollId } = req.body;
    const location = String(req.body.location || "").trim();

    // Validate user exists
    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }

    // Check for duplicate binding
    const existingBinding = await PosRollBinding.exists({
      userId,
      posRollId,
      posClientPaperCode: req.body.posClientPaperCode,
      clientPosGsm: Number(req.body.clientPosGsm),
      posRatePerRoll: Number(req.body.posRatePerRoll),
      posSaleCost: Number(req.body.posSaleCost),
      posMinQty: Number(req.body.posMinQty),
      posOdrQty: Number(req.body.posOdrQty),
      posOdrFreq: req.body.posOdrFreq,
      posCreditTerm: req.body.posCreditTerm,
      posMtrsDel: Number(req.body.posMtrsDel || 0),
      location,
    });
    if (existingBinding) {
      return res
        .status(400)
        .json({ success: false, message: "This exact POS Roll binding configuration already exists for this user at this location." });
    }

    // Create POS Roll binding
    const posRollBinding = await PosRollBinding.create({
      posClientPaperCode: req.body.posClientPaperCode,
      clientPosGsm: Number(req.body.clientPosGsm),
      posRatePerRoll: Number(req.body.posRatePerRoll),
      posSaleCost: Number(req.body.posSaleCost),
      posMinQty: Number(req.body.posMinQty),
      posOdrQty: Number(req.body.posOdrQty),
      posOdrFreq: req.body.posOdrFreq,
      posCreditTerm: req.body.posCreditTerm,
      posMtrsDel: Number(req.body.posMtrsDel || 0),
      userId,
      posRollId,
      location,
    });

    // Attach to user
    user.posRoll.push(posRollBinding._id);
    await user.save();

    res.locals.auditDescription = `Created POS Roll binding "${posRollBinding.posClientPaperCode}" for "${user.userName}"`;
    req.flash("notification", "POS Roll binding created successfully!");
    res.json({ success: true, redirect: "/fairtech/client/details/" + userId });
  } catch (err) {
    console.error("POS ROLL BINDING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create POS Roll binding." });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/pos-roll-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");
    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter POS Roll Specs (cascading smart form) */
router.get("/form/pos-roll-binding/filter-specs", async (req, res) => {
  try {
    const { posPaperCode, posPaperType, posGsm, posWidth, posMtrs, posCoreId, posColor } = req.query;

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

    const buildFilter = (excludeKey) => {
      const f = {};
      if (posPaperCode && excludeKey !== "posPaperCode") f.posPaperCode = flex(posPaperCode);
      if (posPaperType && excludeKey !== "posPaperType") f.posPaperType = flex(posPaperType);
      if (posGsm && excludeKey !== "posGsm") f.posGsm = flex(posGsm);
      if (posWidth && excludeKey !== "posWidth") f.posWidth = flex(posWidth);
      if (posMtrs && excludeKey !== "posMtrs") f.posMtrs = flex(posMtrs);
      if (posCoreId && excludeKey !== "posCoreId") f.posCoreId = flex(posCoreId);
      if (posColor && excludeKey !== "posColor") f.posColor = flex(posColor);
      return f;
    };

    const [paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, colors] = await Promise.all([
      PosRoll.distinct("posPaperCode", buildFilter("posPaperCode")),
      PosRoll.distinct("posPaperType", buildFilter("posPaperType")),
      PosRoll.distinct("posGsm", buildFilter("posGsm")),
      PosRoll.distinct("posWidth", buildFilter("posWidth")),
      PosRoll.distinct("posMtrs", buildFilter("posMtrs")),
      PosRoll.distinct("posCoreId", buildFilter("posCoreId")),
      PosRoll.distinct("posColor", buildFilter("posColor")),
    ]);

    res.json({ paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, colors });
  } catch (err) {
    console.error("FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve POS Roll from Specifications */
router.get("/form/pos-roll-binding/resolve-pos-roll", async (req, res) => {
  console.log("Resolve POS Roll query:", req.query);
  try {
    const { posPaperCode, posPaperType, posGsm, posWidth, posMtrs, posCoreId, posColor } = req.query;

    if (!posPaperCode || !posPaperType || !posGsm || !posWidth || !posMtrs || !posCoreId || !posColor) {
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

    const posRoll = await PosRoll.findOne({
      posPaperCode: flex(posPaperCode),
      posPaperType: flex(posPaperType),
      posGsm: flex(posGsm),
      posWidth: flex(posWidth),
      posMtrs: flex(posMtrs),
      posCoreId: flex(posCoreId),
      posColor: flex(posColor),
    }).lean();

    if (!posRoll) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      posRollId: posRoll._id,
      posProductId: posRoll.posProductId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Display bound POS Rolls */
router.get("/pos-roll/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({
        path: "posRoll",
        populate: [
          { path: "posRollId", model: "PosRoll" }, // POS Roll master
          { path: "userId", model: "Username" }, // User ref
        ],
      })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("back");
    }

    const posRollData = user.posRoll || [];

    // Fetch stock for all bound POS Rolls
    const posRollIds = posRollData.map((binding) => binding.posRollId?._id).filter(Boolean);
    const stockMap = {};
    if (posRollIds.length) {
      const stockAgg = await PosRollStock.aggregate([
        { $match: { posRoll: { $in: posRollIds } } },
        { $group: { _id: "$posRoll", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }
    posRollData.forEach((binding) => {
      const pid = binding.posRollId?._id?.toString();
      binding.stock = stockMap[pid] || 0;
    });

    res.render("inventory/posRoll/posRollDisp.ejs", {
      jsonData: posRollData,
      CSS: "tableDisp.css",
      JS: false,
      title: "POS Roll Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("POS ROLL VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : All client bindings for a POS Roll master */
router.get("/pos-roll/master-view/clients/:posRollId", async (req, res) => {
  try {
    const posRoll = await PosRoll.findById(req.params.posRollId).lean();
    if (!posRoll) {
      req.flash("notification", "POS Roll master not found");
      return res.redirect("back");
    }

    const bindings = await PosRollBinding.find({ posRollId: req.params.posRollId })
      .populate({ path: "posRollId", model: "PosRoll" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    const stockAgg = await PosRollStock.aggregate([
      { $match: { posRoll: posRoll._id } },
      { $group: { _id: "$posRoll", total: { $sum: "$quantity" } } },
    ]);
    const stock = stockAgg[0]?.total || 0;
    bindings.forEach((b) => { b.stock = stock; });

    res.render("inventory/posRoll/posRollDisp.ejs", {
      jsonData: bindings,
      CSS: "tableDisp.css",
      JS: false,
      title: `Clients bound to ${posRoll.posProductId}`,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("POS ROLL MASTER CLIENTS VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : All vendor bindings for a POS Roll master */
router.get("/pos-roll/master-view/vendors/:posRollId", async (req, res) => {
  try {
    const posRoll = await PosRoll.findById(req.params.posRollId).lean();
    if (!posRoll) {
      req.flash("notification", "POS Roll master not found");
      return res.redirect("back");
    }

    const bindings = await VendorPosRollBinding.find({ posRollId: req.params.posRollId })
      .populate("vendorUserId")
      .populate("posRollId")
      .lean();

    const stockAgg = await PosRollStock.aggregate([
      { $match: { posRoll: posRoll._id } },
      { $group: { _id: "$posRoll", total: { $sum: "$quantity" } } },
    ]);
    const stock = stockAgg[0]?.total || 0;

    const jsonData = bindings.map((binding) => ({
      ...binding,
      stock,
      displayValue: binding.posRollId?.posProductId || "",
      vendorName: binding.vendorUserId?.vendorName || "",
      userName: binding.vendorUserId?.userName || "",
      userContact: binding.vendorUserId?.userContact || "",
    }));

    res.render("inventory/posRoll/posRollVendorDisp.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: `Vendors bound to ${posRoll.posProductId}`,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("POS ROLL MASTER VENDORS VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : Compare Client POS Roll vs Master */
router.get("/pos-roll/compare/:id", async (req, res) => {
  try {
    const binding = await PosRollBinding.findById(req.params.id)
      .populate({ path: "posRollId", model: "PosRoll" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    if (!binding) {
      req.flash("notification", "POS Roll binding not found");
      return res.redirect("back");
    }

    const pos = binding.posRollId || {};
    const user = binding.userId || {};
    const vendorBinding = pos._id
      ? await VendorPosRollBinding.findOne({ posRollId: pos._id }).populate({ path: "vendorUserId", model: "VendorUser" }).lean()
      : null;
    const vb = vendorBinding || {};

    const compareRows = [
      { field: "Paper Code", vendorValue: vb.vendorPosPaperCode || "-", orgValue: pos.posPaperCode || "N/A", clientValue: binding.posClientPaperCode || "N/A" },
      { field: "Paper Type", vendorValue: vb.vendorPosPaperType || "-", orgValue: pos.posPaperType || "N/A", clientValue: pos.posPaperType || "N/A" },
      // Color/Width/Meters/Core ID are fixed physical specs of the PosRoll
      // master (VendorPosRollBinding has no per-vendor fields for these), so
      // the vendor's value is the same master spec it's supplying.
      { field: "Color", vendorValue: pos.posColor || "-", orgValue: pos.posColor || "N/A", clientValue: pos.posColor || "N/A" },
      { field: "GSM", vendorValue: vb.vendorPosGsm ?? "-", orgValue: pos.posGsm ?? "N/A", clientValue: binding.clientPosGsm ?? "N/A" },
      { field: "Width", vendorValue: pos.posWidth ?? "-", orgValue: pos.posWidth ?? "N/A", clientValue: pos.posWidth ?? "N/A" },
      { field: "Meters", vendorValue: pos.posMtrs ?? "-", orgValue: pos.posMtrs ?? "N/A", clientValue: pos.posMtrs ?? "N/A" },
      { field: "Core ID", vendorValue: pos.posCoreId ?? "-", orgValue: pos.posCoreId ?? "N/A", clientValue: pos.posCoreId ?? "N/A" },
      { field: "Minimum Qty", vendorValue: vb.posMinQty ?? "-", orgValue: "-", clientValue: binding.posMinQty ?? "N/A" },
      { field: "Order Qty", vendorValue: vb.posOdrQty ?? "-", orgValue: "-", clientValue: binding.posOdrQty ?? "N/A" },
      { field: "Order Frequency", vendorValue: vb.posOdrFreq || "-", orgValue: "-", clientValue: binding.posOdrFreq || "N/A" },
      { field: "Credit Term", vendorValue: vb.posCreditTerm || "-", orgValue: "-", clientValue: binding.posCreditTerm || "N/A" },
      { field: "Rate Per Roll", vendorValue: vb.posRatePerRoll ?? "-", orgValue: "-", clientValue: binding.posRatePerRoll ?? "N/A" },
      { field: "Sale Cost", vendorValue: vb.posSaleCost ?? "-", orgValue: "-", clientValue: binding.posSaleCost ?? "N/A" },
      { field: "Meters Delivered", vendorValue: vb.posMtrsDel ?? "-", orgValue: "-", clientValue: binding.posMtrsDel ?? 0 },
      { field: "Status", vendorValue: vb.status || "-", orgValue: "-", clientValue: binding.status || "N/A" },
    ];

    res.render("inventory/itemCompare.ejs", {
      title: "POS Roll Compare",
      CSS: false,
      JS: false,
      itemTitle: "POS Roll Details",
      sectionTitle: "POS Roll Details (Vendor - Fairtech - Client)",
      vendorLabel: "Vendor",
      orgLabel: "Fairtech",
      clientLabel: "Client",
      editBindingUrl: `/fairtech/pos-roll-binding/edit/${binding._id}`,
      clientName: user?.clientName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("POS ROLL COMPARE ERROR:", err);
    req.flash("notification", "Failed to load POS Roll comparison");
    res.redirect("back");
  }
});

/* GET : Load POS Roll Binding Edit Form */
router.get("/pos-roll-binding/edit/:id", async (req, res) => {
  try {
    const binding = await PosRollBinding.findById(req.params.id).populate("posRollId").populate("userId");

    if (!binding) {
      req.flash("notification", "POS Roll binding not found");
      return res.redirect("back");
    }

    res.render("inventory/posRoll/posRollBindingEdit.ejs", {
      title: "Edit POS Roll Binding",
      binding,
      userLocations: getUserLocationNames(binding.userId, binding.location),
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("EDIT BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load POS Roll Binding Edit");
    res.redirect("back");
  }
});

/* POST : Update POS Roll Binding */
router.post("/pos-roll-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      posClientPaperCode,
      clientPosGsm,
      posMtrsDel,
      posRatePerRoll,
      posSaleCost,
      posMinQty,
      posOdrQty,
      posOdrFreq,
      posCreditTerm,
      status,
      returnTo,
    } = req.body;

    const binding = await PosRollBinding.findById(id);
    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect("back");
    }

    // Location is now selectable on edit; keep the existing one if none sent.
    const location = String(req.body.location || "").trim() || binding.location;
    if (!location) {
      req.flash("notification", "Please select a location");
      return res.redirect("back");
    }
    binding.location = location;

    binding.posClientPaperCode = posClientPaperCode;
    binding.clientPosGsm = Number(clientPosGsm);
    binding.posMtrsDel = Number(posMtrsDel);
    binding.posRatePerRoll = Number(posRatePerRoll);
    binding.posSaleCost = Number(posSaleCost);
    binding.posMinQty = Number(posMinQty);
    binding.posOdrQty = Number(posOdrQty);
    binding.posOdrFreq = posOdrFreq;
    binding.posCreditTerm = posCreditTerm;

    if (status) {
      binding.status = status;
    }

    await binding.save();

    res.locals.auditDescription = `Updated POS Roll binding "${binding.posClientPaperCode}"`;
    req.flash("notification", "POS Roll binding updated successfully!");

    if (typeof returnTo === "string" && returnTo.startsWith("/fairtech/")) {
      return res.redirect(returnTo);
    }

    res.redirect("/fairtech/pos-roll/view/" + binding.userId);
  } catch (err) {
    console.error("EDIT BINDING POST ERROR:", err);
    if (err.code === 11000) {
      req.flash("notification", "A POS Roll binding with this exact configuration already exists.");
    } else {
      req.flash("notification", "Failed to update POS Roll Binding");
    }
    res.redirect("back");
  }
});

router.post("/pos-roll-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await PosRollBinding.findById(id).select("userId posClientPaperCode").lean();

    if (!binding) {
      req.flash("notification", "POS Roll binding not found");
      return res.redirect("back");
    }

    await PosRollBinding.deleteOne({ _id: id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { posRoll: id } });

    res.locals.auditDescription = `Deleted POS Roll binding "${binding.posClientPaperCode}"`;
    req.flash("notification", "POS Roll binding removed successfully!");
    return res.redirect(`/fairtech/pos-roll/view/${binding.userId}`);
  } catch (err) {
    console.error("POS ROLL BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove POS Roll binding");
    return res.redirect("back");
  }
});

router.post("/pos-roll-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await PosRollBinding.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set POS Roll binding "${binding.posClientPaperCode}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("POS ROLL SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

router.post("/pos-roll-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await PosRollBinding.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set POS Roll binding "${binding.posClientPaperCode}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("POS ROLL SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

export default router;
