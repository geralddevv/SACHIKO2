import express from "express";
import Tape from "../../models/inventory/tape.js";
import PosRoll from "../../models/inventory/posRoll.js";
import Tafeta from "../../models/inventory/tafeta.js";
import Vendor from "../../models/users/vendor.js";
import VendorUser from "../../models/users/vendorUser.js";
import VendorTapeBinding from "../../models/inventory/vendorTapeBinding.js";
import VendorPosRollBinding from "../../models/inventory/vendorPosRollBinding.js";
import VendorTafetaBinding from "../../models/inventory/vendorTafetaBinding.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { getUserLocationNames } from "../../utils/locations.js";

const router = express.Router();

const ITEM_CONFIGS = {
  tape: {
    key: "tape",
    title: "Vendor Tape",
    heading: "Vendor Tape",
    template: "inventory/tape/tapeVendorBinding.ejs",
    redirectTo: "/fairtech/vendor/coordinator/view",
    bindingModel: VendorTapeBinding,
    bindingField: "tapeId",
    vendorArrayField: "tape",
    masterModel: Tape,
    displayValueKey: "tapeProductId",
    widthField: "tapeWidth",
    mtrsField: "tapeMtrs",
    rateField: "tapeRatePerRoll",
    saleCostField: "tapeSaleCost",
    minQtyField: "tapeMinQty",
    odrQtyField: "tapeOdrQty",
    specFields: [
      { id: "tape-paper-code", name: "tapePaperCode", label: "Paper Code" },
      { id: "tape-paper-type", name: "tapePaperType", label: "Paper Type", type: "select" },
      { id: "tape-gsm", name: "tapeGsm", label: "GSM" },
      { id: "tape-width", name: "tapeWidth", label: "Width" },
      { id: "tape-mtrs", name: "tapeMtrs", label: "Meters" },
      { id: "tape-core-id", name: "tapeCoreId", label: "Core ID", type: "select" },
      { id: "tape-finish", name: "tapeFinish", label: "Finish", type: "select" },
    ],
    overrideFields: [
      { id: "vendor-tape-paper-code", name: "vendorTapePaperCode", label: "Vendor Paper Code", type: "text" },
      { id: "vendor-tape-gsm", name: "vendorTapeGsm", label: "Vendor GSM", type: "number" },
      { id: "vendor-tape-paper-type", name: "vendorTapePaperType", label: "Vendor Paper Type", type: "text" },

      { id: "tape-min-qty", name: "tapeMinQty", label: "MSQ", type: "number" },
      { id: "tape-rate-per-roll", name: "tapeRatePerRoll", label: "Rate Per Roll", type: "number" },
    ],
  },
  pos: {
    key: "pos",
    title: "Vendor POS Roll",
    heading: "Vendor POS Roll",
    template: "inventory/posRoll/posRollVendorBinding.ejs",
    redirectTo: "/fairtech/vendor/coordinator/view",
    bindingModel: VendorPosRollBinding,
    bindingField: "posRollId",
    vendorArrayField: "posRoll",
    masterModel: PosRoll,
    displayValueKey: "posProductId",
    widthField: "posWidth",
    mtrsField: "posMtrs",
    rateField: "posRatePerRoll",
    saleCostField: "posSaleCost",
    minQtyField: "posMinQty",
    odrQtyField: "posOdrQty",
    specFields: [
      { id: "pos-paper-code", name: "posPaperCode", label: "Paper Code" },
      { id: "pos-paper-type", name: "posPaperType", label: "Paper Type" },
      { id: "pos-gsm", name: "posGsm", label: "GSM" },
      { id: "pos-width", name: "posWidth", label: "Width" },
      { id: "pos-mtrs", name: "posMtrs", label: "Meters" },
      { id: "pos-core-id", name: "posCoreId", label: "Core ID", type: "select" },
      { id: "pos-color", name: "posColor", label: "Color", type: "select" },
    ],
    overrideFields: [
      { id: "vendor-pos-paper-code", name: "vendorPosPaperCode", label: "Vendor Paper Code", type: "text" },
      { id: "vendor-pos-gsm", name: "vendorPosGsm", label: "Vendor GSM", type: "number" },
      { id: "pos-mtrs-del-input", name: "posMtrsDel", label: "MTRS Delivered", type: "number" },
      { id: "pos-rate-per-roll", name: "posRatePerRoll", label: "Rate Per Roll", type: "number" },
      { id: "pos-sale-cost", name: "posSaleCost", label: "Sales sq mtrs Cost", type: "number", readonly: true },
      { id: "pos-min-qty", name: "posMinQty", label: "Minimum Order QTY", type: "number" },
      { id: "pos-odr-qty", name: "posOdrQty", label: "Order QTY", type: "number" },
      { id: "pos-odr-freq", name: "posOdrFreq", label: "Repeat Order Freq", type: "text" },
      { id: "pos-credit-term", name: "posCreditTerm", label: "CR", type: "text" },
    ],
  },
  tafeta: {
    key: "tafeta",
    title: "Vendor Tafeta",
    heading: "Vendor Tafeta",
    template: "inventory/tafeta/tafetaVendorBinding.ejs",
    redirectTo: "/fairtech/vendor/coordinator/view",
    bindingModel: VendorTafetaBinding,
    bindingField: "tafetaId",
    vendorArrayField: "tafeta",
    masterModel: Tafeta,
    displayValueKey: "tafetaProductId",
    widthField: "tafetaWidth",
    mtrsField: "tafetaMtrs",
    rateField: "tafetaRatePerRoll",
    saleCostField: "tafetaSaleCost",
    minQtyField: "tafetaMinQty",
    odrQtyField: "tafetaOdrQty",
    specFields: [
      { id: "tafeta-material-code", name: "tafetaMaterialCode", label: "Material Code" },
      { id: "tafeta-material-type", name: "tafetaMaterialType", label: "Material Type", type: "select" },
      { id: "tafeta-color", name: "tafetaColor", label: "Color" },
      { id: "tafeta-gsm", name: "tafetaGsm", label: "GSM" },
      { id: "tafeta-width", name: "tafetaWidth", label: "Width" },
      { id: "tafeta-mtrs", name: "tafetaMtrs", label: "Meters" },
      { id: "tafeta-core-len", name: "tafetaCoreLen", label: "Core Len" },
      { id: "tafeta-notch", name: "tafetaNotch", label: "Notch", type: "select" },
      { id: "tafeta-core-id", name: "tafetaCoreId", label: "Core ID", type: "select" },
    ],
    overrideFields: [
      { id: "vendor-tafeta-material-code", name: "vendorTafetaMaterialCode", label: "Vendor Material Code", type: "text" },
      { id: "vendor-tafeta-gsm", name: "vendorTafetaGsm", label: "Vendor GSM", type: "text" },
      { id: "tafeta-mtrs-del-input", name: "tafetaMtrsDel", label: "MTRS Delivered", type: "text" },
      { id: "tafeta-rate-per-roll", name: "tafetaRatePerRoll", label: "Rate Per Roll", type: "number" },
      { id: "tafeta-sale-cost", name: "tafetaSaleCost", label: "Sales sq mtrs Cost", type: "number", readonly: true },
      { id: "tafeta-min-qty", name: "tafetaMinQty", label: "Minimum Order QTY", type: "number" },
      { id: "tafeta-odr-qty", name: "tafetaOdrQty", label: "Order QTY", type: "number" },
      { id: "tafeta-odr-freq", name: "tafetaOdrFreq", label: "Repeat Order Freq", type: "text" },
      { id: "tafeta-credit-term", name: "tafetaCreditTerm", label: "CR", type: "text" },
    ],
  },
};

function getConfig(kind) {
  return ITEM_CONFIGS[String(kind || "").toLowerCase()] || null;
}

function flex(value) {
  if (!value && value !== 0) return value;
  const arr = [value];
  if (typeof value === "string") {
    const t = value.trim();
    if (t !== value) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(value));
  }
  return { $in: arr };
}

function buildFilter(query, excludeKey) {
  const f = {};
  Object.entries(query).forEach(([key, value]) => {
    if (!value || excludeKey === key) return;
    f[key] = flex(value);
  });
  return f;
}

async function renderBindingForm(req, res, kind) {
  const config = getConfig(kind);
  if (!config) return res.status(404).send("Vendor binding type not found");

  const { itemId } = req.query;
  let prefillData = null;
  if (itemId && /^[a-f\d]{24}$/i.test(itemId)) {
    prefillData = await config.masterModel.findById(itemId).lean();
  }

  const distinctPromises = config.specFields.map((field) => config.masterModel.distinct(field.name));
  const specValues = await Promise.all(distinctPromises);
  const specOptions = {};
  config.specFields.forEach((field, index) => {
    specOptions[field.name] = specValues[index];
  });

  const vendors = await Vendor.distinct("vendorName");
  const template = config.template || "inventory/vendorItemBinding.ejs";
  res.render(template, {
    title: config.title,
    pageConfig: config,
    specOptions,
    vendors,
    prefillData,
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
}

async function saveBinding(req, res, kind) {
  try {
    const config = getConfig(kind);
    if (!config) return res.status(404).json({ success: false, message: "Invalid vendor binding type" });

    const { vendorUserId } = req.body;
    const masterId = req.body[config.bindingField];
    const location = String(req.body.location || "").trim();

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }

    const vendorUser = await VendorUser.findById(vendorUserId);
    if (!vendorUser) {
      return res.status(400).json({ success: false, message: "Invalid vendor user selected" });
    }

    const existingBinding = await config.bindingModel.exists({
      vendorUserId,
      [config.bindingField]: masterId,
      location,
    });

    if (existingBinding) {
      return res.status(400).json({ success: false, message: "This vendor binding already exists for this user at this location." });
    }

    const createData = {
      ...req.body,
      vendorUserId,
      [config.bindingField]: masterId,
      location,
    };

    if (config.bindingField === "tapeId") {
      createData.vendorTapeGsm = Number(req.body.vendorTapeGsm);
      createData.tapeMinQty = Number(req.body.tapeMinQty);
      if (req.body.tapeRatePerRoll) createData.tapeRatePerRoll = Number(req.body.tapeRatePerRoll);
    }
    if (config.bindingField === "posRollId") {
      createData.vendorPosGsm = Number(req.body.vendorPosGsm);
      createData.posMinQty = Number(req.body.posMinQty);
      // Only set optional fields if they were actually submitted
      if (req.body.posMtrsDel !== undefined && req.body.posMtrsDel !== "") {
        createData.posMtrsDel = Number(req.body.posMtrsDel);
      }
      if (req.body.posRatePerRoll !== undefined && req.body.posRatePerRoll !== "") {
        createData.posRatePerRoll = Number(req.body.posRatePerRoll);
      }
      if (req.body.posSaleCost !== undefined && req.body.posSaleCost !== "") {
        createData.posSaleCost = Number(req.body.posSaleCost);
      }
      if (req.body.posOdrQty !== undefined && req.body.posOdrQty !== "") {
        createData.posOdrQty = Number(req.body.posOdrQty);
      }
      // Remove any empty-string values so Mongoose doesn't try to cast them
      ["posRatePerRoll", "posSaleCost", "posOdrQty", "posMtrsDel"].forEach((key) => {
        if (createData[key] !== undefined && isNaN(createData[key])) {
          delete createData[key];
        }
      });
    }
    if (config.bindingField === "tafetaId") {
      createData.tafetaMinQty = Number(req.body.tafetaMinQty);
      // Only set optional numeric fields if present
      if (req.body.tafetaRatePerRoll !== undefined && req.body.tafetaRatePerRoll !== "") {
        createData.tafetaRatePerRoll = Number(req.body.tafetaRatePerRoll);
      }
      if (req.body.tafetaSaleCost !== undefined && req.body.tafetaSaleCost !== "") {
        createData.tafetaSaleCost = Number(req.body.tafetaSaleCost);
      }
      if (req.body.tafetaOdrQty !== undefined && req.body.tafetaOdrQty !== "") {
        createData.tafetaOdrQty = Number(req.body.tafetaOdrQty);
      }
      // Purge any NaN values
      ["tafetaRatePerRoll", "tafetaSaleCost", "tafetaOdrQty"].forEach((key) => {
        if (createData[key] !== undefined && isNaN(createData[key])) {
          delete createData[key];
        }
      });
    }

    const binding = await config.bindingModel.create(createData);

    // Sync MSQ to master item
    const minQtyValue = createData[config.minQtyField];
    if (minQtyValue || minQtyValue === 0) {
      await config.masterModel.updateOne({ _id: masterId }, { $set: { [config.minQtyField]: minQtyValue } });
    }

    vendorUser[config.vendorArrayField].push(binding._id);
    await vendorUser.save();

    res.locals.auditDescription = `Created ${config.title} binding for "${vendorUser.vendorName || vendorUser.userName}"`;
    req.flash("notification", `${config.title} binding created successfully!`);
    res.json({ success: true, redirect: config.redirectTo });
  } catch (err) {
    console.error("VENDOR ITEM BINDING ERROR:", err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "A vendor binding with this exact configuration already exists." });
    }
    res.status(400).json({ success: false, message: err.message });
  }
}

async function fetchVendorByName(req, res) {
  try {
    const vendorData = await Vendor.findOne({ vendorName: req.params.name }).populate("users").lean();
    res.status(200).json(vendorData);
  } catch (err) {
    console.error("VENDOR FETCH ERROR:", err);
    res.status(500).json(null);
  }
}

async function filterSpecs(req, res, kind) {
  try {
    const config = getConfig(kind);
    if (!config) return res.status(404).json(null);
    const query = {};
    config.specFields.forEach((field) => {
      if (req.query[field.name]) query[field.name] = req.query[field.name];
    });

    const distinctPromises = config.specFields.map((field) =>
      config.masterModel.distinct(field.name, buildFilter(query, field.name)),
    );
    const specValues = await Promise.all(distinctPromises);
    const out = {};
    config.specFields.forEach((field, index) => {
      out[field.name] = specValues[index];
    });
    res.json(out);
  } catch (err) {
    console.error("VENDOR FILTER ERROR:", err);
    res.status(500).json(null);
  }
}

async function resolveMaster(req, res, kind) {
  try {
    const config = getConfig(kind);
    if (!config) return res.status(404).json(null);

    const query = {};
    config.specFields.forEach((field) => {
      const value = req.query[field.name];
      if (!value) return;
      query[field.name] = flex(value);
    });

    if (config.specFields.some((field) => !req.query[field.name])) {
      return res.status(400).json(null);
    }

    const master = await config.masterModel.findOne(query).lean();
    if (!master) return res.status(404).json(null);

    res.json({
      ...master,
      itemId: master._id,
      displayValue: master[config.displayValueKey] || master.tapeProductId || master.posProductId || master.tafetaProductId || master._id,
      [config.minQtyField]: master[config.minQtyField] || "",
    });
  } catch (err) {
    console.error("VENDOR RESOLVE ERROR:", err);
    res.status(500).json(null);
  }
}

router.get("/form/vendor-item-binding/:kind", async (req, res) => renderBindingForm(req, res, req.params.kind));
router.post("/form/vendor-item-binding/:kind", requireAuth, createLimiter, async (req, res) => saveBinding(req, res, req.params.kind));
router.get("/form/vendor-item-binding/:kind/vendor/:name", fetchVendorByName);
router.get("/form/vendor-item-binding/:kind/filter-specs", async (req, res) => filterSpecs(req, res, req.params.kind));
router.get("/form/vendor-item-binding/:kind/resolve", async (req, res) => resolveMaster(req, res, req.params.kind));

/* GET : Display Vendor Bound Items */
router.get("/vendor-item/view/:kind", async (req, res) => {
  try {
    const { kind } = req.params;
    const config = getConfig(kind);
    if (!config) return res.status(404).send("Vendor binding type not found");

    const userId =
      typeof req.query.userId === "string" && /^[a-f\d]{24}$/i.test(req.query.userId.trim())
        ? req.query.userId.trim()
        : "";

    const bindingFilter = userId ? { vendorUserId: userId } : {};
    const vendorUser = userId ? await VendorUser.findById(userId).select("vendorName userName").lean() : null;

    const bindings = await config.bindingModel
      .find(bindingFilter)
      .populate("vendorUserId")
      .populate(config.bindingField)
      .lean();

    // Fetch stock for all bound items
    const masterIds = bindings.map((b) => b[config.bindingField]?._id).filter(Boolean);
    const stockMap = {};

    if (masterIds.length) {
      let StockModel;
      let matchField;
      if (kind === "tape") {
        StockModel = (await import("../../models/inventory/TapeStock.js")).default;
        matchField = "tape";
      } else if (kind === "pos") {
        StockModel = (await import("../../models/inventory/PosRollStock.js")).default;
        matchField = "posRoll";
      } else if (kind === "tafeta") {
        StockModel = (await import("../../models/inventory/TafetaStock.js")).default;
        matchField = "tafeta";
      }

      if (StockModel) {
        const stockAgg = await StockModel.aggregate([
          { $match: { [matchField]: { $in: masterIds } } },
          { $group: { _id: `$${matchField}`, total: { $sum: "$quantity" } } },
        ]);
        stockAgg.forEach((row) => {
          stockMap[row._id.toString()] = row.total;
        });
      }
    }

    const jsonData = bindings.map((binding) => {
      const master = binding[config.bindingField];
      const mid = master?._id?.toString();
      return {
        ...binding,
        stock: stockMap[mid] || 0,
        displayValue: master ? master[config.displayValueKey] : "",
        vendorName: binding.vendorUserId?.vendorName || "",
        userName: binding.vendorUserId?.userName || "",
        userContact: binding.vendorUserId?.userContact || "",
      };
    });

    const displayTemplates = {
      tape: "inventory/tape/tapeVendorDisp.ejs",
      pos: "inventory/posRoll/posRollVendorDisp.ejs",
      tafeta: "inventory/tafeta/tafetaVendorDisp.ejs",
    };

    res.render(displayTemplates[kind] || "inventory/itemVendorDisp.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: `Vendor ${kind.toUpperCase()} Display`,
      vendorUser,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(`VENDOR ${req.params.kind.toUpperCase()} VIEW ERROR:`, err);
    req.flash("notification", `Failed to load Vendor ${req.params.kind} view`);
    res.redirect("/fairtech/vendor/coordinator/view");
  }
});

/* GET : Edit Vendor Binding */
router.get("/vendor-item/edit/:kind/:id", async (req, res) => {
  try {
    const { kind, id } = req.params;
    const config = getConfig(kind);
    if (!config) return res.status(404).send("Type not found");

    const binding = await config.bindingModel.findById(id).populate("vendorUserId").populate(config.bindingField).lean();

    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect("back");
    }

    const editTemplates = {
      tape: "inventory/tape/tapeVendorBindingEdit.ejs",
      pos: "inventory/posRoll/posRollVendorBindingEdit.ejs",
      tafeta: "inventory/tafeta/tafetaVendorBindingEdit.ejs",
    };

    const template = editTemplates[kind];
    if (!template) return res.status(404).send("Page not found");

    res.render(template, {
      title: `Edit Vendor ${kind.toUpperCase()} Binding`,
      binding,
      userLocations: getUserLocationNames(binding.vendorUserId, binding.location),
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR EDIT GET ERROR:", err);
    res.redirect("back");
  }
});

/* POST : Update Vendor Binding */
router.post("/vendor-item/edit/:kind/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { kind, id } = req.params;
    const config = getConfig(kind);
    if (!config) return res.status(404).json({ success: false, message: "Type not found" });

    const { returnTo } = req.body;
    const updateData = { ...req.body };

    const location = String(req.body.location || "").trim();
    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }
    updateData.location = location;

    // Numerical conversions based on kind
    if (kind === "tape") {
      updateData.vendorTapeGsm = Number(req.body.vendorTapeGsm);
      updateData.tapeMinQty = Number(req.body.tapeMinQty);
      if (req.body.tapeRatePerRoll) updateData.tapeRatePerRoll = Number(req.body.tapeRatePerRoll);
    } else if (kind === "pos") {
      updateData.vendorPosGsm = Number(req.body.vendorPosGsm);
      updateData.posMinQty = Number(req.body.posMinQty);
      if (req.body.posRatePerRoll) updateData.posRatePerRoll = Number(req.body.posRatePerRoll);
    } else if (kind === "tafeta") {
      updateData.tafetaMinQty = Number(req.body.tafetaMinQty);
      if (req.body.tafetaRatePerRoll) updateData.tafetaRatePerRoll = Number(req.body.tafetaRatePerRoll);
    }

    const binding = await config.bindingModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!binding) return res.status(404).json({ success: false, message: "Binding not found" });

    // Also sync MinQty to master
    if (updateData[config.minQtyField] || updateData[config.minQtyField] === 0) {
      await config.masterModel.updateOne(
        { _id: binding[config.bindingField] },
        { $set: { [config.minQtyField]: Number(updateData[config.minQtyField]) } },
      );
    }

    const overrideCode = updateData.vendorTapePaperCode || updateData.vendorPosPaperCode || updateData.vendorTafetaMaterialCode || binding._id;
    res.locals.auditDescription = `Updated vendor ${config.title} binding "${overrideCode}"`;
    req.flash("notification", "Binding updated successfully!");
    res.json({ success: true, redirect: returnTo || `/fairtech/vendor-item/view/${kind}?userId=${binding.vendorUserId}` });
  } catch (err) {
    console.error("VENDOR EDIT POST ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* GET : Compare Vendor Binding */
router.get("/vendor-item/compare/:kind/:id", async (req, res) => {
  try {
    const { kind, id } = req.params;
    const config = getConfig(kind);
    if (!config) return res.status(404).send("Type not found");

    const binding = await config.bindingModel.findById(id).populate("vendorUserId").populate(config.bindingField).lean();

    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect("back");
    }

    const master = binding[config.bindingField] || {};
    const vendorUser = binding.vendorUserId || {};

    // Build comparison rows based on kind
    let compareRows = [];
    if (kind === "tape") {
      compareRows = [
        { field: "Paper Code", orgValue: binding.vendorTapePaperCode || "N/A", clientValue: master.tapePaperCode || "N/A" },
        { field: "Paper Type", orgValue: binding.vendorTapePaperType || "N/A", clientValue: master.tapePaperType || "N/A" },
        { field: "GSM", orgValue: binding.vendorTapeGsm ?? "N/A", clientValue: master.tapeGsm ?? "N/A" },
        { field: "Sample ID", orgValue: "-", clientValue: master.tapeProductId || "N/A" },
        { field: "Width", orgValue: "-", clientValue: master.tapeWidth || "N/A" },
        { field: "Meters", orgValue: "-", clientValue: master.tapeMtrs || "N/A" },
        { field: "Finish", orgValue: "-", clientValue: master.tapeFinish || "N/A" },
        { field: "Core ID", orgValue: "-", clientValue: master.tapeCoreId || "N/A" },
        { field: "MSQ", orgValue: "-", clientValue: master.tapeMinQty ?? binding.tapeMinQty ?? "N/A" },
        { field: "Status", orgValue: binding.status || "ACTIVE", clientValue: "-" },
      ];
    } else if (kind === "pos") {
      compareRows = [
        { field: "Paper Code", orgValue: binding.vendorPosPaperCode || "N/A", clientValue: master.posPaperCode || "N/A" },
        { field: "GSM", orgValue: binding.vendorPosGsm ?? "N/A", clientValue: master.posGsm ?? "N/A" },
        { field: "Sample ID", orgValue: "-", clientValue: master.posProductId || "N/A" },
        { field: "Paper Type", orgValue: "-", clientValue: master.posPaperType || "N/A" },
        { field: "Width", orgValue: "-", clientValue: master.posWidth || "N/A" },
        { field: "Meters", orgValue: "-", clientValue: master.posMtrs || "N/A" },
        { field: "Core ID", orgValue: "-", clientValue: master.posCoreId || "N/A" },
        { field: "Color", orgValue: "-", clientValue: master.posColor || "N/A" },
        { field: "MSQ", orgValue: "-", clientValue: master.posMinQty ?? binding.posMinQty ?? "N/A" },
        { field: "Status", orgValue: binding.status || "ACTIVE", clientValue: "-" },
      ];
    } else if (kind === "tafeta") {
      compareRows = [
        { field: "Material Code", orgValue: binding.vendorTafetaMaterialCode || "N/A", clientValue: master.tafetaMaterialCode || "N/A" },
        { field: "GSM", orgValue: binding.vendorTafetaGsm ?? "N/A", clientValue: master.tafetaGsm ?? "N/A" },
        { field: "Sample ID", orgValue: "-", clientValue: master.tafetaProductId || "N/A" },
        { field: "Material Type", orgValue: "-", clientValue: master.tafetaMaterialType || "N/A" },
        { field: "Color", orgValue: "-", clientValue: master.tafetaColor || "N/A" },
        { field: "Width", orgValue: "-", clientValue: master.tafetaWidth || "N/A" },
        { field: "Meters", orgValue: "-", clientValue: master.tafetaMtrs || "N/A" },
        { field: "Core Len", orgValue: "-", clientValue: master.tafetaCoreLen || "N/A" },
        { field: "Notch", orgValue: "-", clientValue: master.tafetaNotch || "N/A" },
        { field: "Core ID", orgValue: "-", clientValue: master.tafetaCoreId || "N/A" },
        { field: "MSQ", orgValue: "-", clientValue: master.tafetaMinQty ?? binding.tafetaMinQty ?? "N/A" },
        { field: "Status", orgValue: binding.status || "ACTIVE", clientValue: "-" },
      ];
    }

    res.render("inventory/itemCompare.ejs", {
      title: `Vendor ${kind.toUpperCase()} Compare`,
      CSS: false,
      JS: false,
      itemTitle: `${kind.toUpperCase()} Details`,
      sectionTitle: `${kind.toUpperCase()} Details (Vendor - Fairtech)`,
      orgLabel: "Vendor",
      clientLabel: "Fairtech",
      editBindingUrl: `/fairtech/vendor-item/edit/${kind}/${binding._id}`,
      clientName: vendorUser?.vendorName || "",
      userName: vendorUser?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COMPARE ERROR:", err);
    res.redirect("back");
  }
});

/* POST : Delete Vendor Binding */
router.post("/vendor-item/delete/:kind/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { kind, id } = req.params;
    const config = getConfig(kind);
    if (!config) return res.status(404).json({ success: false, message: "Type not found" });

    const binding = await config.bindingModel.findById(id).lean();
    if (!binding) return res.status(404).json({ success: false, message: "Binding not found" });

    await config.bindingModel.deleteOne({ _id: id });
    await VendorUser.updateOne({ _id: binding.vendorUserId }, { $pull: { [config.vendorArrayField]: id } });

    const deletedCode = binding.vendorTapePaperCode || binding.vendorPosPaperCode || binding.vendorTafetaMaterialCode || id;
    res.locals.auditDescription = `Deleted vendor ${config.title} binding "${deletedCode}"`;
    req.flash("notification", "Binding removed successfully!");
    res.redirect(`/fairtech/vendor-item/view/${kind}?userId=${binding.vendorUserId}`);
  } catch (err) {
    console.error("VENDOR DELETE ERROR:", err);
    res.redirect("back");
  }
});


export default router;
