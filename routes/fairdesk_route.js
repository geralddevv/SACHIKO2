import express, { json } from "express";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import mongoose from "mongoose";
// import asyncHandler from "express-async-handler";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";
import Vendor from "../models/users/vendor.js";
import VendorUser from "../models/users/vendorUser.js";
import Employee from "../models/hr/employee_model.js";
import Label from "../models/inventory/labels.js";
import Tape from "../models/inventory/tape.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import LabelStockBinding from "../models/sachiko/labelStockBinding.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";
import PurchaseOrder from "../models/inventory/PurchaseOrder.js";
import SystemId from "../models/system/systemId.js";
import Calculator from "../models/utilities/calculator.js";
import Block from "../models/utilities/block_model.js";
import Die from "../models/utilities/die_model.js";
import Task from "../models/miscellaneous/task_model.js";
import DaybookEntry from "../models/miscellaneous/daybook_model.js";
import Machine from "../models/system/machine.js";
import TapeStock from "../models/inventory/TapeStock.js";
import TapeStockLog from "../models/inventory/TapeStockLog.js";
import SalesOrderLog from "../models/inventory/SalesOrderLog.js";
import PurchaseOrderLog from "../models/inventory/PurchaseOrderLog.js";
import VendorTapeBinding from "../models/inventory/vendorTapeBinding.js";
import Location from "../models/system/location.js";
import Counter from "../models/system/counter.js";
import AuditLog from "../models/system/auditLog.js";
import Sample from "../models/inventory/sample.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MachineJobCard from "../models/inventory/machineJobCard.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";
import FacestockStock from "../models/inventory/facestockStock.js";
import AdhesiveStock from "../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";
import { escapeRegex } from "../utils/security.js";
import { getUserLocationNames, normalizeLocationName } from "../utils/locations.js";
import { generateMaterialRollId } from "../utils/materialRollId.js";
import {
  reconcileUserBindingLocations,
  syncLabelBindingIdentity,
} from "../utils/reconcileBindingLocations.js";
import { upsertPendingProduction, removePendingProduction } from "../utils/pendingProduction.js";
import { produceDeckle, dissolveDeckle, requiredLayersFor, trackAllottedCombinations, LAYER_META, POOL_MODELS, pickStockIds } from "../utils/labelStockProduction.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../utils/limiters.js";

const router = express.Router();

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function duplicateMasterMessage(item, productId) {
  return `${item} already exist with id: ${productId || "unknown"}`;
}

// Pending value = remaining (undispatched) balance * order rate, summed over
// PENDING + CONFIRMED orders (an order can be partially dispatched while
// staying CONFIRMED). Shared by the sales-pending header totals across the
// Tape/TTR, Plain Label, and Color Label pending pages.
function remainingOrderValuePipeline(extraMatch = {}, statuses = ["PENDING", "CONFIRMED"]) {
  return [
    { $match: { status: { $in: statuses }, ...extraMatch } },
    {
      $project: {
        balance: { $max: [{ $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }, 0] },
        orderRate: { $ifNull: ["$orderRate", 0] },
      },
    },
    { $group: { _id: null, total: { $sum: { $multiply: ["$balance", "$orderRate"] } } } },
  ];
}

function canonicalizeLocationName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

function toNumber(value) {
  return Number(value || 0);
}

function getProfileStockConfig(itemType) {
  const map = {
    Tape: {
      itemLabel: "Tape",
      stockModel: TapeStock,
      logModel: TapeStockLog,
      itemField: "tape",
      onModel: "Tape",
    },
  };
  return map[itemType] || null;
}

async function getItemStockSummary(itemType, itemId, excludeOrderId = null) {
  const config = getProfileStockConfig(itemType);
  if (!config) throw new Error(`Unsupported stock item type: ${itemType}`);
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const bookedMatch = {
    tapeId: itemObjectId,
    onModel: config.onModel,
    status: { $in: ["PENDING", "CONFIRMED"] },
  };
  if (excludeOrderId) {
    bookedMatch._id = { $ne: new mongoose.Types.ObjectId(excludeOrderId) };
  }

  const [stockAggregation, bookedAggregation] = await Promise.all([
    config.stockModel.aggregate([
      { $match: { [config.itemField]: itemObjectId } },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } },
          },
          qty: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.location": 1 } },
    ]),
    TapeSalesOrder.aggregate([
      { $match: bookedMatch },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } },
          },
          bookedQty: {
            $sum: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] },
          },
        },
      },
    ]),
  ]);

  const stockMap = new Map(
    stockAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.qty)]),
  );
  const bookedMap = new Map(
    bookedAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.bookedQty)]),
  );

  const locations = Array.from(new Set([...stockMap.keys(), ...bookedMap.keys()]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((location) => {
      const qty = toNumber(stockMap.get(location));
      const booked = toNumber(bookedMap.get(location));
      return {
        location,
        qty,
        booked,
        balance: qty - booked,
      };
    })
    .filter((entry) => entry.qty !== 0 || entry.booked !== 0);

  const totalStock = locations.reduce((sum, entry) => sum + toNumber(entry.qty), 0);
  const totalBooked = locations.reduce((sum, entry) => sum + toNumber(entry.booked), 0);
  const totalBalance = totalStock - totalBooked;

  return {
    locations,
    totalStock,
    totalBooked,
    totalBalance,
    booked: totalBooked, // for compatibility
    balance: totalBalance, // for compatibility
  };
}

async function applyItemStockDelta({ itemType, itemId, location, delta, remarks, createdBy, extraFields = {} }) {
  const config = getProfileStockConfig(itemType);
  if (!config) throw new Error(`Unsupported stock item type: ${itemType}`);
  const normalizedLocation = canonicalizeLocationName(location) || "UNKNOWN";
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const matchQuery = { [config.itemField]: itemObjectId, location: normalizedLocation };
  if (extraFields.tapeFinish) {
    matchQuery.tapeFinish = extraFields.tapeFinish;
  }

  const [balanceRow] = await config.stockModel.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = toNumber(balanceRow?.qty);
  const closingStock = openingStock + delta;

  if (delta === 0) {
    return { openingStock, closingStock, changed: false };
  }

  await config.stockModel.create({
    [config.itemField]: itemObjectId,
    location: normalizedLocation,
    quantity: delta,
    remarks,
    ...extraFields,
  });

  await config.logModel.create({
    [config.itemField]: itemObjectId,
    location: normalizedLocation,
    openingStock,
    quantity: Math.abs(delta),
    closingStock,
    type: delta > 0 ? "INWARD" : "OUTWARD",
    source: "MANUAL",
    remarks,
    createdBy: createdBy || "SYSTEM",
    ...extraFields,
  });

  return { openingStock, closingStock, changed: true };
}

// Keys must match the exact itemType strings passed at each handleProfileStockEdit call site.
const STOCK_EDIT_PRODUCT_ID_FIELD = {
  Tape: "tapeProductId",
};

async function handleProfileStockEdit(req, res, { itemType, model, redirectPath }) {
  try {
    const productIdField = STOCK_EDIT_PRODUCT_ID_FIELD[itemType];
    const selectFields = ["_id", productIdField];
    if (itemType === "Tape") selectFields.push("tapeFinish");
    const item = await model.findById(req.params.id).select(selectFields.join(" ")).lean();
    if (!item) {
      req.flash("notification", `${itemType} not found`);
      return res.redirect(redirectPath);
    }
    const itemLabel = item[productIdField] || String(item._id);

    const fromLocation = canonicalizeLocationName(req.body.fromLocation) || "UNKNOWN";
    const toLocation = canonicalizeLocationName(req.body.toLocation) || "UNKNOWN";
    const requestedQuantity = Number(req.body.quantity);
    const itemProfileUrl = `${redirectPath}/${item._id}`;

    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 0) {
      req.flash("notification", "Enter a valid stock quantity");
      return res.redirect(itemProfileUrl);
    }

    const stockSummary = await getItemStockSummary(itemType, item._id);
    const sourceEntry = stockSummary.locations.find((entry) => entry.location === fromLocation);
    const currentQuantity = toNumber(sourceEntry?.qty);
    const sourceBooked = toNumber(sourceEntry?.booked);
    const createdBy = req.user?.username || req.session?.authUser?.username || "SYSTEM";

    console.log(`[STOCK_EDIT] ${itemType} ${item._id} | From: ${fromLocation} To: ${toLocation} | ReqQty: ${requestedQuantity} | CurrQty: ${currentQuantity} | Booked: ${sourceBooked}`);

    if (!sourceEntry && currentQuantity === 0 && sourceBooked === 0) {
      req.flash("notification", "Stock location not found");
      return res.redirect(itemProfileUrl);
    }

    const extraFields = itemType === "Tape" ? { tapeFinish: item.tapeFinish } : {};

    if (fromLocation === toLocation) {
      const delta = requestedQuantity - currentQuantity;
      if (delta === 0) {
        req.flash("notification", "Stock is already up to date");
        return res.redirect(itemProfileUrl);
      }

      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: fromLocation,
        delta,
        remarks: `${itemType} stock adjusted to ${requestedQuantity} from profile`,
        createdBy,
        extraFields,
      });
      res.locals.auditDescription = `Adjusted ${itemType} "${itemLabel}" stock at "${fromLocation}" to ${requestedQuantity} (was ${currentQuantity})`;
      req.flash("notification", `${itemType} stock updated successfully.`);
      return res.redirect(itemProfileUrl);
    }

    if (sourceBooked > 0) {
      req.flash("notification", `Cannot move stock from ${fromLocation} while booked quantity (${sourceBooked}) exists.`);
      return res.redirect(itemProfileUrl);
    }

    if (currentQuantity !== 0) {
      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: fromLocation,
        delta: -currentQuantity,
        remarks: `${itemType} stock moved from ${fromLocation} to ${toLocation} via profile`,
        createdBy,
        extraFields,
      });
    }

    if (requestedQuantity !== 0) {
      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: toLocation,
        delta: requestedQuantity,
        remarks: `${itemType} stock moved from ${fromLocation} to ${toLocation} via profile`,
        createdBy,
        extraFields,
      });
    }

    res.locals.auditDescription = `Moved ${itemType} "${itemLabel}" stock (qty ${requestedQuantity || currentQuantity}) from "${fromLocation}" to "${toLocation}"`;
    req.flash("notification", `${itemType} stock location updated successfully.`);
    return res.redirect(itemProfileUrl);
  } catch (err) {
    console.error(`${itemType.toUpperCase()} PROFILE STOCK EDIT ERROR:`, err);
    req.flash("notification", `Failed to update ${itemType} stock`);
    return res.redirect(`${redirectPath}/${req.params.id}`);
  }
}

function buildSalesOrderSignature({
  itemType,
  itemId,
  userId,
  quantity,
  estimatedDate,
  poNumber,
  sourceLocation,
  orderRate,
  createdBy,
}) {
  return hashSignature(
    [
      itemType || "",
      itemId || "",
      userId || "",
      String(quantity ?? ""),
      String(estimatedDate || ""),
      canonicalizeLocationName(sourceLocation || ""),
      String(poNumber || "").trim(),
      String(orderRate ?? ""),
      String(createdBy || ""),
    ].join("|"),
  );
}

// Same duplicate-prevention scheme as routes/sachiko/labelStockBinding.js'
// buildBindingSignature -- reproduced here since a Label Stock order for a
// product with no existing binding auto-creates one (see the LABEL_STOCK
// branch of POST /sales/order) and must land on the identical signature a
// manually-created binding for the same labelStock+user+paperSize+RM would,
// so it's found instead of duplicated on a second such order.
function buildLabelStockBindingSignature({ labelStock, userId, paperSize, runningMeters }) {
  return hashSignature(
    [
      String(labelStock || ""),
      String(userId || ""),
      String(paperSize || "").trim().toUpperCase().replace(/\s+/g, " "),
      String(Number(runningMeters ?? "")),
    ].join("||"),
  );
}

// Resolves the LabelStockBinding for labelStock+userId+paperSize+runningMeters,
// reusing one whose bindingSignature already matches, otherwise creating it
// from what the order form collected for Rate/Location -- the same inputs a
// manually-created binding would need (see POST /form/label-stock-binding in
// routes/sachiko/labelStockBinding.js). Used by the LABEL_STOCK branch of
// POST /sales/order both when the picked product has no binding at all yet,
// and when an existing binding was picked but the order's own Paper Size/
// Running Meters don't match it -- the same labelStock+client pair can have
// several bindings, one per paperSize+RM combo (that's the whole point of
// bindingSignature excluding nothing but location), so a mismatch there
// means a *different* binding is being asked for, not an edit of the one
// that was picked.
async function resolveLabelStockBinding({ labelStock, userId, paperSize, runningMeters, itemRate, sourceLocation, locationRadio, userLocation }) {
  const bindingRate = Number(itemRate);
  if (!Number.isFinite(bindingRate) || bindingRate <= 0) {
    return { error: "Rate is required to bind this product to the client." };
  }
  const bindingLocation = canonicalizeLocationName(sourceLocation || locationRadio || userLocation);
  if (!bindingLocation || bindingLocation === "ALL") {
    return { error: "Select a location for this product." };
  }

  const bindingSignature = buildLabelStockBindingSignature({ labelStock, userId, paperSize, runningMeters });
  let binding = await LabelStockBinding.findOne({ bindingSignature });
  if (!binding) {
    binding = await LabelStockBinding.create({
      labelStock,
      userId,
      location: bindingLocation,
      paperSize,
      runningMeters: Number(runningMeters),
      rate: bindingRate,
      bindingSignature,
    });
    // Same linkage step the manual Label Stock Binding form does -- without
    // it the binding exists but is invisible on /label-stock-binding/view/:id
    // and to /sales/items, which both resolve a user's bindings via
    // Username.labelStock rather than by querying LabelStockBinding directly.
    await Username.updateOne({ _id: userId }, { $addToSet: { labelStock: binding._id } });
  }
  return { binding };
}

function isTemplateOnlyInvoice(invoiceNumber) {
  const value = String(invoiceNumber || "").trim();
  if (!value) return true;
  return /^TECH\|IN\|\d{2}-\d{2}\|[A-Z_]+\|$/i.test(value);
}

router.use((req, res, next) => {
  const authUser = req.session?.authUser;
  const role = String(authUser?.role || "").toLowerCase();
  const permissions = authUser?.permissions || {};
  const hasSalesAccess = role === "sales" || Boolean(permissions.sales);
  const hasHrAccess = role === "hr" || Boolean(permissions.hr);

  if (!role) return res.redirect("/sachiko/login");

  if (role === "proprietor" || role === "admin" || role === "hod") return next();

  if (req.path === "/api/motivational") return next();

  // Company Tasks is open to every role that reaches this router (sales, hr —
  // not gated behind the narrower per-role allowlists below).
  if (req.path === "/tasks" || req.path.startsWith("/tasks/") || req.path.startsWith("/api/tasks/")) return next();

  // Daybook is a personal view onto the same Tasks data, so it gets the same
  // open access as Tasks above.
  if (req.path === "/daybook" || req.path.startsWith("/daybook/") || req.path.startsWith("/api/daybook/")) return next();

  if (hasSalesAccess) {
    const path = req.path || "";

    if (path.startsWith("/sales/")) return next();
    if (path === "/stocks/view" || path === "/pettycash/view" || path === "/pettycash/create") return next();

    // Explicitly allowed GET routes for Sales
    const allowedGetRoutes = [
      "/welcome",
      "/master/view",
      "/client/view",
      "/form/client",
      "/tape/view",
      "/form/tape-binding",
      "/stocks/view",
      "/pettycash/view",
      "/labels/view",
      "/form/tape-master",
    ];

    const allowedGetPatterns = [
      /^\/form\/client\/[^/]+$/,
      /^\/client\/details\/[^/]+$/,
      /^\/tape\/profile\/[^/]+$/,
      /^\/tape\/edit\/[^/]+$/,
      /^\/form\/tape-binding(?:\/.*)?$/,
      /^\/api\/motivational$/,
      /^\/form\/labels\/.*$/,
      /^\/api\/locations$/,
      /^\/labels\/profile\/[^/]+$/,
      /^\/labels\/file\/[^/]+\/[^/]+$/,
      /^\/labels\/view\/[^/]+$/,
      /^\/labels\/edit\/[^/]+$/,
    ];

    const allowedPostRoutes = [
      /^\/form\/client$/,
      /^\/form\/user$/,
      /^\/form\/tape-binding$/,
      /^\/tape\/edit\/[^/]+$/,
      /^\/pettycash\/create$/,
      /^\/labels\/edit\/[^/]+$/,
      /^\/form\/tape$/,
    ];

    if (req.method === "GET") {
      const normalizedPath = path.toLowerCase().replace(/\/$/, "");

      // Explicit keyword matches for resilience
      const keywords = ["master/view", "compare", "binding", "welcome", "api/motivational", "tape/view", "client", "vendor", "user", "stocks", "pettycash"];
      if (keywords.some(k => normalizedPath.includes(k))) return next();

      if (allowedGetRoutes.includes(normalizedPath) || allowedGetPatterns.some((re) => re.test(path))) {
        return next();
      }
    }

    if (req.method === "POST" && (path.includes("binding") || path.includes("user") || allowedPostRoutes.some((re) => re.test(path)))) {
      return next();
    }

    return res.status(403).send(`Forbidden (FR-Sales): ${path} | Role: ${role}`);
  }

  if (hasHrAccess) {
    const path = req.path || "";
    if (path === "/welcome" || path === "/api/motivational") return next();
    return res.status(403).send(`Forbidden (FR-HR): ${path} | Role: ${role}`);
  }

  return res.status(403).send(`Forbidden (FR-Final): ${req.path} | Role: ${role}`);
});

router.get("/form/ratecalculator", async (req, res) => {
  let clients = await Username.distinct("clientName");
  res.render("utilities/rateCalculator.ejs", {
    clients,
    title: "Rate Calculator",
    JS: "rateCalculator.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle rate calculator form submission
router.post("/form/ratecalculator", requireAuth, createLimiter, async (req, res) => {
  try {
    await Calculator.create(req.body);
    res.send("Order created successfully!");
  } catch (err) {
    console.error("RATE CALCULATOR CREATE ERROR:", err);
    res.status(400).send("Failed to save: " + err.message);
  }
});

// ----------------------------------Client---------------------------------->
// route for client form.
router.get("/form/client", async (req, res) => {
  const getNextClientIdPreview = async () => {
    const counterDoc = await Counter.findOne({ key: "clientId" }).select("seq").lean();
    let nextSeq = Number(counterDoc?.seq || 0) + 1;

    // Skip any legacy collisions so preview stays aligned with generator behavior.
    while (await Client.exists({ clientId: `FS | CLIENT | ${nextSeq}` })) {
      nextSeq += 1;
    }
    return `FS | CLIENT | ${nextSeq}`;
  };

  let clients = await Client.distinct("clientName");
  const employees = await Employee.find({}, "empName").sort({ empName: 1 }).lean();
  let userCount = await Username.countDocuments();
  const previewClientId = await getNextClientIdPreview();
  res.render("users/clientForm.ejs", {
    JS: "clientForm.js",
    CSS: "tabOpt.css",
    title: "Client Form",
    userCount,
    previewClientId,
    clients,
    employees,
    notification: req.flash("notification"),
  });
});

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function duplicateClientMessage(clientId) {
  return `client already exist: "${clientId || "unknown"}"`;
}

function duplicateUserMessage(userName, clientName) {
  return `"${userName || "unknown"}" already exist for this "${clientName || "unknown"}"`;
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
  ].join("||");
}

function normalizeUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeUserName(value) {
  return normalizeUserPart(value).toUpperCase();
}

function normalizeUserEmail(value) {
  return normalizeUserPart(value).toLowerCase();
}

function normalizeUserContact(value) {
  return normalizeUserPart(value).replace(/\D/g, "");
}

function normalizeLocationDetails(rawLocationDetails, fallbackLocation, fallbackAddress) {
  const source = Array.isArray(rawLocationDetails)
    ? rawLocationDetails
    : rawLocationDetails && typeof rawLocationDetails === "object"
      ? Object.values(rawLocationDetails)
      : [];

  const locations = source
    .map((entry) => {
      // Normalized the same way as item bindings (utils/locations.js), so a
      // stray trailing comma/dot (e.g. pasted from "Tarapur, Maharashtra")
      // can't desync a client's location from their bindings' location field
      // — see the /master/view and /labels/view "binding not showing" bug.
      const userLocation = normalizeLocationName(entry?.userLocation ?? entry?.location);
      const dispatchAddress = String(entry?.dispatchAddress ?? entry?.address ?? "").trim().toUpperCase();

      if (!userLocation && !dispatchAddress) return null;

      const out = { userLocation, dispatchAddress };

      // Per-location dispatch details — only stored when they carry a value.
      // A self-dispatch entry keeps just selfDispatch; transport fields are
      // omitted. For transport entries, empty fields are dropped too.
      if (String(entry?.selfDispatch ?? "").trim()) {
        out.selfDispatch = "Self Dispatch";
      } else {
        const set = (key, value) => { if (value) out[key] = value; };
        set("transportName", String(entry?.transportName ?? "").trim().toUpperCase());
        set("transportContact", String(entry?.transportContact ?? "").trim());
        set("dropLocation", String(entry?.dropLocation ?? "").trim().toUpperCase());
        set("dropLocation1", String(entry?.dropLocation1 ?? "").trim().toUpperCase());
        set("deliveryMode", String(entry?.deliveryMode ?? "").trim());
        set("deliveryLocation", String(entry?.deliveryLocation ?? "").trim().toUpperCase());
        set("deliveryLocation1", String(entry?.deliveryLocation1 ?? "").trim().toUpperCase());
        set("clientPayment", String(entry?.clientPayment ?? "").trim());
        set("vendorPayment", String(entry?.vendorPayment ?? "").trim());
      }

      return out;
    })
    .filter(Boolean);

  if (!locations.length) {
    const userLocation = normalizeLocationName(fallbackLocation);
    const dispatchAddress = String(fallbackAddress || "").trim().toUpperCase();
    if (userLocation || dispatchAddress) {
      locations.push({ userLocation, dispatchAddress });
    }
  }

  return locations;
}

function buildUserSignature(source, userId) {
  return [
    normalizeClientPart(userId),
    normalizeUserName(source.userName),
    normalizeUserEmail(source.userEmail),
    normalizeUserContact(source.userContact),
  ].join("||");
}

// Route to handle CLIENT form submission
router.post("/form/client", requireAuth, createLimiter, async (req, res) => {
  try {
    const generateClientId = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key: "clientId" },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateId = `FS | CLIENT | ${counter.seq}`;
        const exists = await Client.exists({ clientId: candidateId });
        if (!exists) return candidateId;
      }
      throw new Error("Unable to generate unique client id");
    };

    const clientName = String(req.body.clientName || "").trim();
    const clientType = String(req.body.clientType || "").trim();
    const clientStatus = String(req.body.clientStatus || "").trim();
    const hoLocation = String(req.body.hoLocation || "").trim();
    const accountHead = String(req.body.accountHead || "").trim();
    const clientGst = String(req.body.clientGst || "").trim().toUpperCase();
    const clientMsme = String(req.body.clientMsme || "").trim();
    const clientGumasta = String(req.body.clientGumasta || "").trim();
    const clientPan = String(req.body.clientPan || "").trim().toUpperCase();
    const vendorCode = String(req.body.vendorCode || "").trim();
    const verticals = String(req.body.verticals || "").trim();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (clientGst && !gstRegex.test(clientGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (clientPan && !panRegex.test(clientPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (clientGst && clientPan && clientGst.substring(2, 12) !== clientPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const clientSignature = hashSignature(buildClientSignature(req.body));

    // Prevent duplicates only when the full logical client entity matches.
    // clientId is auto-generated, so it is intentionally excluded from this match.
    const existingSameEntity = await Client.findOne({
      $or: [
        { clientSignature },
        {
          clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
          clientType: new RegExp(`^${escapeRegex(clientType)}$`, "i"),
          clientStatus: new RegExp(`^${escapeRegex(clientStatus)}$`, "i"),
          hoLocation: new RegExp(`^${escapeRegex(hoLocation)}$`, "i"),
          accountHead: new RegExp(`^${escapeRegex(accountHead)}$`, "i"),
          clientGst: new RegExp(`^${escapeRegex(clientGst)}$`, "i"),
          clientMsme: new RegExp(`^${escapeRegex(clientMsme)}$`, "i"),
          clientGumasta: new RegExp(`^${escapeRegex(clientGumasta)}$`, "i"),
          clientPan: new RegExp(`^${escapeRegex(clientPan)}$`, "i"),
        },
      ],
    })
      .select("clientId")
      .lean();

    if (existingSameEntity) {
      return res.status(400).json({
        success: false,
        message: duplicateClientMessage(existingSameEntity.clientId),
      });
    }

    const formData = {
      clientId: await generateClientId(),
      clientName,
      clientType,
      clientStatus,
      hoLocation,
      accountHead,
      clientGst,
      clientMsme,
      clientGumasta,
      clientPan,
      vendorCode,
      verticals,
      clientSignature,
    };

    await Client.create(formData);
    res.locals.auditDescription = `Created client "${clientName}"`;
    req.flash("notification", "Client created successfully!");
    res.json({ success: true, redirect: "/sachiko/client/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const existingClient = await Client.findOne({ clientSignature })
        .select("clientId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateClientMessage(existingClient?.clientId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/client/:name", async (req, res) => {
  let clientData = await Client.findOne({ clientName: req.params.name });
  let clientName = clientData;
  res.status(200).json(clientName);
});

// ----------------------------------Username---------------------------------->
// Route to handle USER form submission
router.post("/form/user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    let client = null;
    if (objectId) {
      client = await Client.findOne({ _id: objectId });
    }
    if (!client) {
      const clientIdFallback = String(req.body.clientId || "").trim();
      const clientNameFallback = String(req.body.clientName || "").trim();
      if (clientIdFallback) {
        client = await Client.findOne({ clientId: clientIdFallback });
      }
      if (!client && clientNameFallback) {
        client = await Client.findOne({ clientName: new RegExp(`^${escapeRegex(clientNameFallback)}$`, "i") });
      }
    }
    if (!client) {
      return res.status(400).json({ success: false, message: "Invalid client selected" });
    }

    const clientId = String(client.clientId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );

    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }

    const primaryLocation = locationDetails[0];
    const userSignature = hashSignature(buildUserSignature(req.body, clientId));

    // Prevent duplicates only on full identity tuple within the same client.
    const duplicateUser = await Username.findOne({
      $or: [
        { userSignature },
        {
          clientId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    })
      .select("userName clientName")
      .lean();

    if (duplicateUser) {
      return res.status(400).json({
        success: false,
        message: duplicateUserMessage(duplicateUser.userName, duplicateUser.clientName || client.clientName),
      });
    }

    const newUser = await Username.create({
      ...req.body,
      clientId,
      clientName: client.clientName,
      clientType: client.clientType,
      hoLocation: client.hoLocation,
      accountHead: client.accountHead,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (sales orders, displays) keep working unchanged.
      SelfDispatch: primaryLocation.selfDispatch || "",
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      clientPayment: primaryLocation.clientPayment || "",
      locationsCount: locationDetails.length,
      locationDetails,
      userName,
      userContact,
      userEmail,
      userSignature,
    });

    client.users.push(newUser);
    await client.save();

    res.locals.auditDescription = `Created user "${userName}" under client "${client.clientName}"`;
    req.flash("notification", "User created successfully!");
    res.json({ success: true, redirect: "/sachiko/master/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const clientId = String(req.body.clientId || "").trim();
      const userName = String(req.body.userName || "").trim();
      const userEmail = String(req.body.userEmail || "")
        .trim()
        .toLowerCase();
      const userContact = String(req.body.userContact || "").trim();
      const fallbackUserSignature = hashSignature(buildUserSignature(req.body, clientId));
      const existingUser = await Username.findOne({
        $or: [
          { userSignature: fallbackUserSignature },
          {
            clientId,
            userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
            userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
            userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
          },
        ],
      })
        .select("userName clientName")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateUserMessage(existingUser?.userName || userName, existingUser?.clientName),
      });
    }
    console.error("CREATE CLIENT USER ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create user." });
  }
});

// ----------------------------------Company Tasks---------------------------------->

// Tasks are personal: a user only ever sees/manages tasks they themselves
// created — this is a private to-do list, not a delegation tool. Ownership
// is keyed strictly on the individual employee's empId — never on role —
// so no two employees (or dev backdoor logins, which have no empId at all
// and therefore can never own or see a task) ever share a task bucket.
function sessionOwnerKey(req) {
  return req.session?.authUser?.empId || null;
}

// "Others" resolution for the task Assigned Employee / Client fields.
async function resolveTaskAssignee(assignedToId, assignedToManualName) {
  if (assignedToId === "OTHERS") {
    const name = String(assignedToManualName || "").trim();
    if (!name) throw new Error("Please enter the employee name.");
    return { assignedTo: null, assignedToIsOthers: true, assignedToOthers: name, empName: name };
  }
  if (!assignedToId || !mongoose.isValidObjectId(assignedToId)) {
    throw new Error("Please select an employee to assign this task to.");
  }
  const employee = await Employee.findById(assignedToId).select("empName").lean();
  if (!employee) throw new Error("Selected employee was not found.");
  return { assignedTo: assignedToId, assignedToIsOthers: false, assignedToOthers: undefined, empName: employee.empName };
}

async function resolveTaskClient(clientId, clientManualName) {
  if (!clientId) return { client: null, clientIsOthers: false, clientOthers: undefined };
  if (clientId === "OTHERS") {
    const name = String(clientManualName || "").trim();
    if (!name) throw new Error("Please enter the company / client name.");
    return { client: null, clientIsOthers: true, clientOthers: name };
  }
  if (!mongoose.isValidObjectId(clientId)) throw new Error("Invalid client selected.");
  const clientDoc = await Client.findById(clientId).select("_id").lean();
  if (!clientDoc) throw new Error("Selected client was not found.");
  return { client: clientId, clientIsOthers: false, clientOthers: undefined };
}

router.get("/tasks", async (req, res) => {
  const ownerKey = sessionOwnerKey(req);
  const [tasks, employees, clients, daybookEntries] = await Promise.all([
    ownerKey
      ? Task.find({ deletedAt: null, createdBy: ownerKey })
          // Task lives on an isolated database connection (config/tasksDb.js), so
          // Mongoose can't resolve these refs by name — pass the actual models.
          .populate({ path: "assignedTo", select: "empName empId", model: Employee })
          .populate({ path: "client", select: "clientName clientId", model: Client })
          .sort({ createdAt: -1 })
          .lean()
      : [],
    Employee.find({ isActive: true }, "empName empId").sort({ empName: 1 }).lean(),
    Client.find().select("clientName clientId").sort({ clientName: 1 }).lean(),
    ownerKey ? DaybookEntry.find({ createdBy: ownerKey }).select("task").lean() : [],
  ]);

  const daybookTaskIds = daybookEntries.map((e) => String(e.task));

  res.render("miscellaneous/tasks.ejs", {
    title: "Company Tasks",
    CSS: "tableDisp.css",
    JS: false,
    tasks,
    daybookTaskIds,
    employees,
    clients,
    notification: req.flash("notification"),
  });
});

// POST: Create a task
router.post("/tasks", requireAuth, createLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(400).json({
        success: false,
        message: "Tasks are tied to your personal employee login. Please sign in with your employee profile code to create tasks.",
      });
    }

    const title = String(req.body.title || "").trim();
    const label = String(req.body.label || "").trim();
    const { assignedTo, assignedToManualName, client, clientManualName, dueDate, status } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: "Task title is required." });
    }

    let assignee, clientInfo;
    try {
      assignee = await resolveTaskAssignee(assignedTo, assignedToManualName);
      clientInfo = await resolveTaskClient(client, clientManualName);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const validStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED"];
    const taskStatus = validStatuses.includes(status) ? status : "PENDING";

    const task = await Task.create({
      title,
      label: label || undefined,
      assignedTo: assignee.assignedTo,
      assignedToIsOthers: assignee.assignedToIsOthers,
      assignedToOthers: assignee.assignedToOthers,
      client: clientInfo.client,
      clientIsOthers: clientInfo.clientIsOthers,
      clientOthers: clientInfo.clientOthers,
      dueDate: dueDate || undefined,
      status: taskStatus,
      createdBy: ownerKey,
    });

    res.locals.auditDescription = `Created task "${task.title}" assigned to "${assignee.empName}"`;
    req.flash("notification", "Task created successfully!");
    res.json({ success: true, redirect: "/sachiko/tasks" });
  } catch (err) {
    console.error("TASK CREATE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create task." });
  }
});

// PUT: Update a task (full edit or a quick status change)
router.put("/api/tasks/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid task id." });
    }

    const update = {};
    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim();
      if (!title) return res.status(400).json({ success: false, message: "Task title is required." });
      update.title = title;
    }
    if (req.body.dueDate !== undefined) {
      update.dueDate = req.body.dueDate || null;
    }
    if (req.body.label !== undefined) {
      update.label = String(req.body.label || "").trim();
    }
    if (req.body.status !== undefined) {
      const validStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED"];
      if (!validStatuses.includes(req.body.status)) {
        return res.status(400).json({ success: false, message: "Invalid status." });
      }
      update.status = req.body.status;
    }
    if (req.body.assignedTo !== undefined) {
      let assignee;
      try {
        assignee = await resolveTaskAssignee(req.body.assignedTo, req.body.assignedToManualName);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      update.assignedTo = assignee.assignedTo;
      update.assignedToIsOthers = assignee.assignedToIsOthers;
      update.assignedToOthers = assignee.assignedToOthers ?? null;
    }
    if (req.body.client !== undefined) {
      let clientInfo;
      try {
        clientInfo = await resolveTaskClient(req.body.client, req.body.clientManualName);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      update.client = clientInfo.client;
      update.clientIsOthers = clientInfo.clientIsOthers;
      update.clientOthers = clientInfo.clientOthers ?? null;
    }

    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null, createdBy: ownerKey },
      update,
      { new: true, runValidators: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    res.locals.auditDescription = `Updated task "${updated.title}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("TASK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE: Soft-delete a task (hidden from listings, not removed from the database)
router.delete("/api/tasks/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const deleted = await Task.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null, createdBy: ownerKey },
      { deletedAt: new Date() },
      { new: true },
    ).select("title").lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }
    res.locals.auditDescription = `Deleted task "${deleted.title}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("TASK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------Daybook---------------------------------->

// Local calendar day, not UTC.
function todayDayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

router.get("/daybook", async (req, res) => {
  const ownerKey = sessionOwnerKey(req);

  const [entries, availableTasks, completedTasks] = await Promise.all([
    ownerKey
      ? DaybookEntry.find({ createdBy: ownerKey })
          .populate({
            path: "task",
            match: { deletedAt: null },
            populate: [
              { path: "assignedTo", select: "empName empId", model: Employee },
              { path: "client", select: "clientName clientId", model: Client },
            ],
          })
          .sort({ createdAt: 1 })
          .lean()
      : [],
    ownerKey
      ? Task.find({ deletedAt: null, createdBy: ownerKey, status: { $ne: "COMPLETED" } })
          .select("title label status dueDate assignedTo assignedToIsOthers assignedToOthers client clientIsOthers clientOthers")
          .populate({ path: "assignedTo", select: "empName", model: Employee })
          .populate({ path: "client", select: "clientName", model: Client })
          .sort({ createdAt: -1 })
          .lean()
      : [],
    ownerKey
      ? Task.find({ deletedAt: null, createdBy: ownerKey, status: "COMPLETED" })
          .select("title label status dueDate assignedTo assignedToIsOthers assignedToOthers client clientIsOthers clientOthers")
          .populate({ path: "assignedTo", select: "empName empId", model: Employee })
          .populate({ path: "client", select: "clientName clientId", model: Client })
          .sort({ createdAt: -1 })
          .lean()
      : [],
  ]);

  const validEntries = entries.filter((e) => e.task);

  const pickedTaskIds = new Set(validEntries.map((e) => String(e.task._id)));
  const pickableTasks = availableTasks.filter((t) => !pickedTaskIds.has(String(t._id)));

  res.render("miscellaneous/daybook.ejs", {
    title: "Daybook",
    CSS: "tableDisp.css",
    JS: false,
    entries: validEntries,
    pickableTasks,
    completedTasks,
    notification: req.flash("notification"),
  });
});

// POST: Pick one or more tasks into today's daybook
router.post("/daybook", requireAuth, createLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(400).json({
        success: false,
        message: "Daybook is tied to your personal employee login. Please sign in with your employee profile code.",
      });
    }

    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : [];
    const validIds = taskIds.filter((id) => mongoose.isValidObjectId(id));
    if (!validIds.length) {
      return res.status(400).json({ success: false, message: "Please select at least one task." });
    }

    const ownedTasks = await Task.find({ _id: { $in: validIds }, deletedAt: null, createdBy: ownerKey }).select("_id").lean();
    const ownedIds = new Set(ownedTasks.map((t) => String(t._id)));
    if (!ownedIds.size) {
      return res.status(400).json({ success: false, message: "No valid tasks selected." });
    }

    const dayKey = todayDayKey();
    const ops = [...ownedIds].map((task) => ({
      updateOne: {
        filter: { dayKey, createdBy: ownerKey, task },
        update: { $setOnInsert: { dayKey, createdBy: ownerKey, task } },
        upsert: true,
      },
    }));
    await DaybookEntry.bulkWrite(ops);

    if (!req.body.silent) req.flash("notification", "Added to Daybook.");
    res.json({ success: true, redirect: "/sachiko/daybook" });
  } catch (err) {
    console.error("DAYBOOK ADD ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to add to Daybook." });
  }
});

// DELETE: Roll a task back out of the daybook by *task* id rather than entry id.
router.delete("/api/daybook/task/:taskId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    if (!mongoose.isValidObjectId(req.params.taskId)) {
      return res.status(400).json({ success: false, message: "Invalid task id." });
    }

    const { deletedCount } = await DaybookEntry.deleteMany({ task: req.params.taskId, createdBy: ownerKey });
    if (!deletedCount) {
      return res.status(404).json({ success: false, message: "Task is not in your Daybook." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DAYBOOK REMOVE BY TASK ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE: Roll a task back out of today's daybook (the Task itself is untouched)
router.delete("/api/daybook/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid daybook entry id." });
    }

    const deleted = await DaybookEntry.findOneAndDelete({ _id: req.params.id, createdBy: ownerKey });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DAYBOOK REMOVE ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels (client binding)---------------------------------->
// Client + user lookup by client name -- still used by the Sales Order form's
// client picker (views/inventory/orders/salesOrderForm.ejs), even though the
// label-creation page that originally used it has been removed.
router.get("/form/labels/:name", async (req, res) => {
  try {
    const rawName = String(req.params.name || "");
    const normalizedName = rawName.trim().replace(/\s+/g, " ");
    // Match any run of whitespace loosely, so stored names that contain
    // stray double spaces (e.g. "KAMAL  ENTERPRISES") still match the
    // whitespace-collapsed value coming from the client dropdown.
    const nameRegex = new RegExp(`^${escapeRegex(normalizedName).replace(/ /g, "\\s+")}$`, "i");

    // 1. Find the Client document
    const clientData = await Client.findOne({ clientName: nameRegex }).lean();

    if (!clientData) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    // 2. Fetch all usernames associated with this client name directly from Username model
    // This is more robust than relying on the Client.users array being perfectly in sync.
    const users = await Username.find({ clientName: nameRegex }).lean();

    // 3. Attach users to clientData and return
    clientData.users = users;

    res.status(200).json(clientData);
  } catch (err) {
    console.error("FORM LABELS LOOKUP ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load client data" });
  }
});

// ----------------------------------Samples---------------------------------->
// Helper: build the counter key and format the sample code
function getMaterialAbbreviation(material) {
  const mat = String(material || "UNKNOWN").trim().toUpperCase();
  if (mat === "FACE PAPER") return "FP";
  if (mat === "ADHESIVE") return "ADH";
  if (mat === "RELEASE PAPER") return "RP";
  if (mat === "SL (PAPER)") return "SL";
  if (mat === "POS ROLL") return "POS";
  return mat.replace(/\s+/g, "-");
}

function formatSampleCode(material, category, seq) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `FS | ${mat} | ${cat} | ${String(seq).padStart(6, "0")}`;
}

function sampleCounterKey(material, category) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `sampleCode_${mat}_${cat}`;
}

// GET: preview next sample code (called by client-side JS on radio change)
router.get("/form/samples/next-code", async (req, res) => {
  try {
    const material = String(req.query.material || "").trim();
    const category = String(req.query.category || "vendor").trim().toLowerCase();
    if (!material) return res.json({ code: "" });

    const key = sampleCounterKey(material, category);
    const counterDoc = await Counter.findOne({ key }).select("seq").lean();
    let nextSeq = Number(counterDoc?.seq || 0) + 1;

    while (await Sample.exists({ sampleCode: formatSampleCode(material, category, nextSeq) })) {
      nextSeq += 1;
    }

    return res.json({ code: formatSampleCode(material, category, nextSeq) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ code: "" });
  }
});

router.get("/form/samples", async (req, res) => {
  res.render("inventory/samples.ejs", {
    title: "Samples",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/form/samples", requireAuth, createLimiter, async (req, res) => {
  try {
    const activeTab = String(req.body.sampleCategory || "").trim().toLowerCase() === "client" ? "client" : "vendor";

    const material = String(req.body.sampleMaterial || "").trim();
    const key = sampleCounterKey(material, activeTab);

    const generateSampleCode = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateCode = formatSampleCode(material, activeTab, counter.seq);
        const exists = await Sample.exists({ sampleCode: candidateCode });
        if (!exists) return candidateCode;
      }
      throw new Error("Unable to generate unique sample code");
    };

    const sampleCode = material ? await generateSampleCode() : String(req.body.sampleCode || "").trim();

    await Sample.create({ ...req.body, sampleCode, sampleCategory: activeTab, sampleMaterial: material });

    res.locals.auditDescription = `Created ${activeTab} sample "${sampleCode}" (${material})`;
    req.flash("notification", `${activeTab === "client" ? "Client" : "Vendor"} sample submitted successfully!`);
    res.json({ success: true, redirect: `/sachiko/form/samples?tab=${activeTab}` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Tape Master---------------------------------->

// GET: Tape Master form
router.get("/form/tape-master", async (req, res) => {
  const formatTapeId = (n) => `FS | Tape | ${String(n).padStart(6, "0")}`;
  const parseTapeSeq = (productId) => {
    const match = String(productId || "").match(/(\d{6})$/);
    return match ? Number(match[1]) : 0;
  };
  const getNextTapeIdPreview = async () => {
    const latestTape = await Tape.findOne().sort({ tapeProductId: -1 }).select("tapeProductId").lean();
    let nextSeq = parseTapeSeq(latestTape?.tapeProductId) + 1;

    while (await Tape.exists({ tapeProductId: formatTapeId(nextSeq) })) {
      nextSeq += 1;
    }
    return formatTapeId(nextSeq);
  };

  const previewTapeProductId = await getNextTapeIdPreview();

  res.render("inventory/tape/tape.ejs", {
    JS: false,
    CSS: false,
    title: "Tape Master",
    previewTapeProductId,
    notification: req.flash("notification"),
  });
});

// POST: Tape Master submission
router.post("/form/tape", requireAuth, createLimiter, async (req, res) => {
  try {
    const formatTapeId = (n) => `FS | Tape | ${String(n).padStart(6, "0")}`;
    const parseTapeSeq = (productId) => {
      const match = String(productId || "").match(/(\d{6})$/);
      return match ? Number(match[1]) : 0;
    };
    const generateTapeProductId = async () => {
      let nextSeq = parseTapeSeq(
        (await Tape.findOne().sort({ tapeProductId: -1 }).select("tapeProductId").lean())?.tapeProductId,
      ) + 1;

      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const candidateId = formatTapeId(nextSeq);
        const exists = await Tape.exists({ tapeProductId: candidateId });
        if (!exists) return candidateId;
        nextSeq += 1;
      }
      throw new Error("Unable to generate unique tape product id");
    };

    // Prevent duplicates based on tape specs (productId is always unique).
    const tapeSignature = hashSignature(buildTapeSignature(req.body));
    const widthRaw = req.body.tapeWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const tapeCoreId = normalizeTapeCoreId(req.body.tapeCoreId);

    const duplicateTapeQuery = {
      $or: [
        { tapeSignature },
        {
          tapePaperCode: flexTapeValue(req.body.tapePaperCode),
          tapeGsm: flexTapeValue(Number(req.body.tapeGsm)),
          tapePaperType: flexTapeValue(req.body.tapePaperType),
          tapeWidth: flexTapeValue(widthVal),
          tapeMtrs: flexTapeValue(Number(req.body.tapeMtrs)),
          tapeCoreId: flexTapeValue(Number(tapeCoreId)),
          tapeAdhesiveGsm: flexTapeValue(req.body.tapeAdhesiveGsm),
          tapeFinish: flexTapeValue(req.body.tapeFinish),
        },
      ],
    };
    const alreadyExists = await Tape.findOne(duplicateTapeQuery).select("tapeProductId").lean();
    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("Tape", alreadyExists.tapeProductId),
      });
    }

    const data = {
      tapeProductId: await generateTapeProductId(),
      tapePaperCode: String(req.body.tapePaperCode).trim(),
      tapeGsm: Number(req.body.tapeGsm),
      tapePaperType: String(req.body.tapePaperType).trim(),
      tapeWidth: widthVal,
      tapeMtrs: Number(req.body.tapeMtrs),
      tapeCoreId: Number(tapeCoreId),
      tapeAdhesiveGsm: String(req.body.tapeAdhesiveGsm).trim(),
      tapeFinish: String(req.body.tapeFinish).trim(),
      tapeSignature,
      createdBy: req.user?.username || "SYSTEM",
    };

    await Tape.create(data);

    res.locals.auditDescription = `Created tape master "${data.tapeProductId}" (${data.tapePaperCode}, ${data.tapeGsm}gsm)`;
    req.flash("notification", "Tape Master created successfully!");
    res.json({ success: true, redirect: "/sachiko/tape/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTape = await Tape.findOne({ tapeSignature: hashSignature(buildTapeSignature(req.body)) })
        .select("tapeProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("Tape", duplicateTape?.tapeProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});


// Route to render Edit USER form
router.get("/form/edit/user/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    let user = await Username.findById(userId);

    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/sachiko/users/master");
    }

    // Build the rows for the form. Dispatch details are now per-location; for
    // legacy users whose stored locationDetails predate that, backfill the
    // primary (first) location's dispatch from the top-level fields so editing
    // doesn't wipe the existing dispatch info.
    const stored = Array.isArray(user.locationDetails) && user.locationDetails.length
      ? user.locationDetails.map((loc) => (loc?.toObject ? loc.toObject() : loc))
      : [{ userLocation: user.userLocation || "", dispatchAddress: user.dispatchAddress || "" }];

    const hasPrimaryDispatch = stored[0] && (
      stored[0].selfDispatch || stored[0].transportName || stored[0].transportContact ||
      stored[0].dropLocation || stored[0].deliveryMode || stored[0].deliveryLocation || stored[0].clientPayment
    );
    if (stored[0] && !hasPrimaryDispatch) {
      stored[0] = {
        ...stored[0],
        selfDispatch: user.SelfDispatch || "",
        transportName: user.transportName || "",
        transportContact: user.transportContact || "",
        dropLocation: user.dropLocation || "",
        deliveryMode: user.deliveryMode || "",
        deliveryLocation: user.deliveryLocation || "",
        clientPayment: user.clientPayment || "",
      };
    }

    res.render("users/editUser", {
      CSS: "tabOpt.css",
      title: "Edit User",
      JS: false,
      user,
      initialLocationDetails: stored,
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("error", "Error loading user data.");
    res.redirect("back");
  }
});

// Route to handle Edit USER submission
router.post("/form/edit/user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    let { userId } = req.params;
    const currentUser = await Username.findById(userId);
    if (!currentUser) {
      req.flash("error", "User not found.");
      return res.redirect("/sachiko/users/master");
    }

    const updateData = {
      userName: String(req.body.userName || "").trim(),
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact: String(req.body.userContact || "").trim(),
      userEmail: String(req.body.userEmail || "")
        .trim()
        .toLowerCase(),
    };

    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );

    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }

    const primaryLocation = locationDetails[0];
    updateData.userLocation = primaryLocation.userLocation;
    updateData.dispatchAddress = primaryLocation.dispatchAddress;
    // Top-level dispatch fields mirror the primary (first) location so existing
    // consumers (sales orders, displays) keep working unchanged.
    updateData.SelfDispatch = primaryLocation.selfDispatch || "";
    updateData.transportName = primaryLocation.transportName || "";
    updateData.transportContact = primaryLocation.transportContact || "";
    updateData.dropLocation = primaryLocation.dropLocation || "";
    updateData.deliveryMode = primaryLocation.deliveryMode || "";
    updateData.deliveryLocation = primaryLocation.deliveryLocation || "";
    updateData.clientPayment = primaryLocation.clientPayment || "";
    updateData.locationsCount = locationDetails.length;
    updateData.locationDetails = locationDetails;

    updateData.userSignature = hashSignature(buildUserSignature(updateData, currentUser.clientId));

    // Prevent duplicate full-entity user data within the same client.
    const duplicateUser = await Username.findOne({
      _id: { $ne: userId },
      clientId: currentUser.clientId,
      userName: new RegExp(`^${escapeRegex(updateData.userName)}$`, "i"),
      userLocation: new RegExp(`^${escapeRegex(updateData.userLocation)}$`, "i"),
      userDepartment: new RegExp(`^${escapeRegex(updateData.userDepartment)}$`, "i"),
      userContact: new RegExp(`^${escapeRegex(updateData.userContact)}$`, "i"),
      userEmail: new RegExp(`^${escapeRegex(updateData.userEmail)}$`, "i"),
      dispatchAddress: new RegExp(`^${escapeRegex(updateData.dispatchAddress)}$`, "i"),
      locationDetails: {
        $elemMatch: {
          userLocation: new RegExp(`^${escapeRegex(primaryLocation.userLocation)}$`, "i"),
          dispatchAddress: new RegExp(`^${escapeRegex(primaryLocation.dispatchAddress)}$`, "i"),
        },
      },
      transportName: new RegExp(`^${escapeRegex(updateData.transportName)}$`, "i"),
      transportContact: new RegExp(`^${escapeRegex(updateData.transportContact)}$`, "i"),
      dropLocation: new RegExp(`^${escapeRegex(updateData.dropLocation)}$`, "i"),
      deliveryMode: new RegExp(`^${escapeRegex(updateData.deliveryMode)}$`, "i"),
      deliveryLocation: new RegExp(`^${escapeRegex(updateData.deliveryLocation)}$`, "i"),
      clientPayment: new RegExp(`^${escapeRegex(updateData.clientPayment)}$`, "i"),
      SelfDispatch: new RegExp(`^${escapeRegex(updateData.SelfDispatch)}$`, "i"),
    }).lean();

    if (duplicateUser) {
      req.flash("error", "User already exists (same full details).");
      return res.redirect("back");
    }

    await Username.findByIdAndUpdate(userId, updateData, { new: true, runValidators: true });

    res.locals.auditDescription = `Updated user "${updateData.userName}"`;
    let notification = "User details updated successfully!";
    try {
      const { fixed, ambiguous } = await reconcileUserBindingLocations(userId);
      if (fixed.length) {
        notification += ` Re-pointed ${fixed.length} item location(s) to match.`;
      }
      if (ambiguous.length) {
        notification += ` ${ambiguous.length} item(s) still reference a location that no longer matches — review manually.`;
      }
    } catch (err) {
      console.error("BINDING LOCATION RECONCILE ERROR:", err);
    }
    try {
      const { fixed: identityFixed } = await syncLabelBindingIdentity(userId);
      if (identityFixed.length) {
        notification += ` Synced name/contact on ${identityFixed.length} label binding(s).`;
      }
    } catch (err) {
      console.error("BINDING IDENTITY SYNC ERROR:", err);
    }
    req.flash("notification", notification);
    res.redirect(`/sachiko/client/details/${userId}`);
  } catch (err) {
    console.error(err);
    req.flash("error", "Error updating user details.");
    res.redirect("back");
  }
});

// ----------------------------------Location Master---------------------------------->

// GET: Location Master form
router.get("/form/location", async (req, res) => {
  const locations = await Location.find().sort({ locationName: 1 }).lean();

  res.render("inventory/masters/locationMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Location Master",
    locations,
    notification: req.flash("notification"),
  });
});

// POST: Location Master submission
router.post("/form/location", requireAuth, createLimiter, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || "")
      .trim()
      .toUpperCase();

    const alreadyExists = await Location.exists({ locationName });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "location already exist" });
    }

    await Location.create({ locationName });
    res.locals.auditDescription = `Created location "${locationName}"`;
    req.flash("notification", "Location created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/location" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "location already exist" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// API: Get all locations as JSON
router.get("/api/locations", async (req, res) => {
  const locations = await Location.distinct("locationName");
  const normalizedLocations = [...new Set(
    locations
      .map((location) => canonicalizeLocationName(location))
      .filter(Boolean)
  )].sort();
  res.json(normalizedLocations);
});

// PUT: Update a location name
router.put("/api/locations/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || "")
      .trim()
      .toUpperCase();

    if (!locationName) {
      return res.status(400).json({ success: false, message: "Location name is required." });
    }

    const alreadyExists = await Location.exists({ locationName, _id: { $ne: req.params.id } });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Location already exists." });
    }

    const updated = await Location.findByIdAndUpdate(
      req.params.id,
      { locationName },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Location not found." });
    }

    res.locals.auditDescription = `Updated location "${locationName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Location already exists." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// DELETE: Remove a location
router.delete("/api/locations/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await Location.findById(req.params.id).select("locationName").lean();
    await Location.findByIdAndDelete(req.params.id);
    res.locals.auditDescription = `Deleted location "${existing?.locationName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Machine Master CRUD (/form/machine, /api/machines) moved to
// routes/system/machine.js, alongside the machine queue / job card pipeline
// it now feeds -- see server.js for why that router is mounted ahead of this
// one.

// ================= TAPE MASTER LIST VIEW =================
router.get("/tape/view", async (req, res) => {
  const tapes = await Tape.find().sort({ tapeProductId: 1 }).lean();
  const tapeIds = tapes.map((t) => t._id).filter(Boolean);

  const [stockAgg, bindingAgg, vendorBindingAgg] = await Promise.all([
    tapeIds.length
      ? TapeStock.aggregate([
          { $match: { tape: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tape",
              qty: { $sum: "$quantity" },
            },
          },
        ])
      : [],
    tapeIds.length
      ? TapeBinding.aggregate([
          { $match: { tapeId: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tapeId",
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    tapeIds.length
      ? VendorTapeBinding.aggregate([
          { $match: { tapeId: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tapeId",
              count: { $sum: 1 },
            },
          },
        ])
      : []
  ]);

  const stockByItem = {};
  stockAgg.forEach((row) => {
    const itemId = String(row._id || "");
    stockByItem[itemId] = Number(row.qty || 0);
  });

  const bindingsByItem = {};
  bindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    bindingsByItem[itemId] = Number(row.count || 0);
  });

  const vendorBindingsByItem = {};
  vendorBindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    vendorBindingsByItem[itemId] = Number(row.count || 0);
  });

  tapes.forEach((t) => {
    const itemId = String(t._id);
    t.stock = stockByItem[itemId] ?? 0;
    t.bindingCount = bindingsByItem[itemId] ?? 0;
    t.vendorBindingCount = vendorBindingsByItem[itemId] ?? 0;
  });

  res.render("inventory/tape/tapeMasterDisp.ejs", {
    jsonData: tapes,
    CSS: "tableDisp.css",
    JS: false,
    title: "Tape View",
    notification: req.flash("notification"),
  });
});

// ================= TTR MASTER LIST VIEW =================
// ================= TAPE PROFILE VIEW =================
router.get("/tape/profile/:id", async (req, res) => {
  const tape = await Tape.findById(req.params.id).lean();

  if (!tape) {
    req.flash("notification", "Tape not found");
    return res.redirect("back");
  }

  const tapeBindings = await TapeBinding.find({ tapeId: req.params.id })
    .populate({ path: "userId", select: "userName clientName hoLocation" })
    .sort({ createdAt: -1 })
    .lean();

  const primaryBinding = tapeBindings[0] || null;
  const backUrl = primaryBinding?.userId?._id
    ? `/sachiko/client/details/${primaryBinding.userId._id}`
    : "/sachiko/tape/view";
  const stockSummary = await getItemStockSummary("Tape", tape._id);
  const locationOptions = await Location.find().sort({ locationName: 1 }).lean();

  const rows = [
    { label: "Product ID", value: tape.tapeProductId || "N/A" },
    { label: "Paper Code", value: tape.tapePaperCode || "N/A" },
    { label: "GSM", value: tape.tapeGsm ?? "N/A" },
    { label: "Paper Type", value: tape.tapePaperType || "N/A" },
    { label: "Adhesive GSM", value: tape.tapeAdhesiveGsm ?? "N/A" },
    { label: "Width", value: tape.tapeWidth ?? "N/A" },
    { label: "Meters", value: tape.tapeMtrs ?? "N/A" },
    { label: "Core ID", value: tape.tapeCoreId ?? "N/A" },
    { label: "Finish", value: tape.tapeFinish || "N/A" },
    { label: "Min Stock Qty", value: tape.tapeMinQty ?? "N/A" },
  ];

  res.render("inventory/itemView.ejs", {
    pageTitle: "Tape Details",
    sectionTitle: "Tape Details",
    valueHeader: "Value",
    statusUrl: `/sachiko/tape/edit/${tape._id}`,
    currentStatus: tape.status || "ACTIVE",
    rows,
    tape,
    tapeBindings,
    primaryBinding,
    backUrl,
    stockInfo: {
      totalStock: stockSummary.totalStock,
      locations: stockSummary.locations,
      booked: stockSummary.totalBooked,
      balance: stockSummary.totalBalance,
    },
    stockEditConfig: {
      enabled: true,
      itemType: "Tape",
      editAction: `/sachiko/tape/profile/${tape._id}/stock/edit`,
      locationOptions: locationOptions.map((entry) => canonicalizeLocationName(entry.locationName)).filter(Boolean),
    },
    title: "Tape Details",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/tape/profile/:id/stock/edit", requireAuth, updateLimiter, async (req, res) =>
  handleProfileStockEdit(req, res, {
    itemType: "Tape",
    model: Tape,
    redirectPath: "/sachiko/tape/profile",
  }));

function normalizePosPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizePosCoreId(value) {
  const raw = normalizePosPart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildPosSignature(source) {
  return [
    normalizePosPart(source.posPaperCode),
    normalizePosPart(source.posPaperType),
    normalizePosPart(source.posColor),
    normalizePosPart(source.posGsm),
    normalizePosPart(source.posWidth),
    normalizePosPart(source.posMtrs),
    normalizePosCoreId(source.posCoreId),
  ].join("||");
}

function flexPosValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

function normalizeTapePart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTapeCoreId(value) {
  const raw = normalizeTapePart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildTapeSignature(source) {
  return [
    normalizeTapePart(source.tapePaperCode),
    normalizeTapePart(source.tapePaperType),
    normalizeTapePart(source.tapeGsm),
    normalizeTapePart(source.tapeWidth),
    normalizeTapePart(source.tapeMtrs),
    normalizeTapeCoreId(source.tapeCoreId),
    normalizeTapePart(source.tapeAdhesiveGsm),
    normalizeTapePart(source.tapeFinish),
  ].join("||");
}

function flexTapeValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

// ================= TAPE EDIT =================
router.post("/tape/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const status = req.body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
    const tapeDoc = await Tape.findByIdAndUpdate(req.params.id, { status }).select("tapeProductId").lean();
    res.locals.auditDescription = `Set tape "${tapeDoc?.tapeProductId || req.params.id}" status to ${status}`;
    req.flash("notification", "Tape status updated successfully!");
    res.redirect(`/sachiko/tape/profile/${req.params.id}`);
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to update tape status");
    res.redirect("back");
  }
});

// ================= TTR PROFILE VIEW =================
// route for vendor form.
router.get("/form/vendor", async (req, res) => {
  const { tab, vendorName } = req.query;
  let vendors = await Vendor.distinct("vendorName");
  let userCount = await VendorUser.countDocuments();
  let vendorCount = vendors.length;
  res.render("users/vendorForm.ejs", {
    JS: "vendorForm.js?v=5",
    CSS: "tabOpt.css",
    title: "Vendor Form",
    vendorCount,
    userCount,
    vendors,
    tab,
    vendorName,
    notification: req.flash("notification"),
  });
});

function normalizeVendorPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildVendorSignature(source) {
  return [
    normalizeVendorPart(source.vendorName),
    normalizeVendorPart(source.vendorStatus),
    normalizeVendorPart(source.hoLocation),
    normalizeVendorPart(source.warehouseLocation),
    normalizeVendorPart(source.vendorGst),
    normalizeVendorPart(source.vendorMsme),
    normalizeVendorPart(source.vendorGumasta),
    normalizeVendorPart(source.vendorPan),
    Array.isArray(source.commodities)
      ? source.commodities.map((c) => normalizeVendorPart(c)).filter(Boolean).join(",")
      : normalizeVendorPart(source.commodities),
  ].join("||");
}

function normalizeVendorUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeVendorUserName(value) {
  return normalizeVendorUserPart(value).toUpperCase();
}

function normalizeVendorUserEmail(value) {
  return normalizeVendorUserPart(value).toLowerCase();
}

function normalizeVendorUserContact(value) {
  return normalizeVendorUserPart(value).replace(/\D/g, "");
}

function buildVendorUserSignature(source, vendorId) {
  const locationDetails = normalizeLocationDetails(
    source.locationDetails,
    source.userLocation,
    source.dispatchAddress,
  );

  // Pick up details are per-location now, so fold each location's own
  // dispatch fields into its slice of the signature instead of relying on
  // top-level source fields (which only hold the primary location's mirror).
  return [
    normalizeVendorPart(vendorId),
    normalizeVendorUserName(source.userName),
    normalizeVendorUserEmail(source.userEmail),
    normalizeVendorUserContact(source.userContact),
    locationDetails
      .map((entry) =>
        [
          entry.userLocation,
          entry.dispatchAddress,
          entry.selfDispatch,
          entry.transportName,
          entry.transportContact,
          entry.dropLocation,
          entry.dropLocation1,
          entry.deliveryMode,
          entry.deliveryLocation,
          entry.deliveryLocation1,
          entry.vendorPayment,
        ]
          .map((value) => normalizeVendorPart(value))
          .join("::"),
      )
      .join("||"),
  ].join("||");
}

function getVendorSnapshot(vendor, fallback = {}) {
  return {
    vendorId: String(vendor?.vendorId ?? fallback.vendorId ?? "").trim(),
    vendorName: String(vendor?.vendorName ?? fallback.vendorName ?? "").trim(),
    vendorStatus: String(vendor?.vendorStatus ?? fallback.vendorStatus ?? "").trim(),
    hoLocation: String(vendor?.hoLocation ?? fallback.hoLocation ?? "").trim(),
    warehouseLocation: String(vendor?.warehouseLocation ?? fallback.warehouseLocation ?? "").trim(),
    vendorGst: String(vendor?.vendorGst ?? fallback.vendorGst ?? "").trim(),
    vendorMsme: String(vendor?.vendorMsme ?? fallback.vendorMsme ?? "").trim(),
    commodities: vendor?.commodities || fallback.commodities || [],
  };
}

// Route to handle VENDOR form submission
router.post("/form/vendor", requireAuth, createLimiter, async (req, res) => {
  try {
    const vendorId = String(req.body.vendorId || "").trim();
    const vendorName = String(req.body.vendorName || "").trim();
    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const vendorSignature = hashSignature(buildVendorSignature(req.body));

    // Prevent duplicates only by full vendor signature.
    const alreadyExists = await Vendor.exists({
      vendorSignature,
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    const formData = {
      vendorId,
      vendorName,
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
      vendorSignature,
    };

    await Vendor.create(formData);
    res.locals.auditDescription = `Created vendor "${vendorName}"`;
    req.flash("notification", "Vendor created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/vendor" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor already exist",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/vendor/:name", async (req, res) => {
  const vendorData = await Vendor.findOne({ vendorName: req.params.name }).lean();
  if (!vendorData) {
    return res.status(404).json({ message: "Vendor not found" });
  }

  vendorData.userCount = await VendorUser.countDocuments({ vendorId: vendorData.vendorId });
  res.status(200).json(vendorData);
});

router.get("/vendor/edit/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).lean();
    if (!vendor) {
      req.flash("notification", "Vendor not found");
      return res.redirect("/sachiko/vendor/view");
    }

    res.render("users/vendorEditForm.ejs", {
      title: "Edit Vendor",
      CSS: "tabOpt.css",
      JS: false,
      vendor,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load vendor edit page");
    res.redirect("/sachiko/vendor/view");
  }
});

router.post("/vendor/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const linkedVendorUsers = await VendorUser.find({ vendorId: vendor.vendorId })
      .select("_id userName userEmail userContact locationDetails")
      .lean();

    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const updatedData = {
      vendorId: String(req.body.vendorId || "").trim(),
      vendorName: String(req.body.vendorName || "").trim(),
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
    };

    updatedData.vendorSignature = hashSignature(buildVendorSignature(updatedData));

    const duplicate = await Vendor.findOne({
      _id: { $ne: req.params.id },
      vendorSignature: updatedData.vendorSignature,
    }).lean();

    if (duplicate) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    await Vendor.findByIdAndUpdate(req.params.id, updatedData, { runValidators: true });

    const vendorSnapshot = getVendorSnapshot(updatedData, updatedData);
    if (linkedVendorUsers.length) {
      const bulkOps = linkedVendorUsers.map((vendorUser) => ({
        updateOne: {
          filter: { _id: vendorUser._id },
          update: {
            $set: {
              ...vendorSnapshot,
              vendorUserSignature: hashSignature(buildVendorUserSignature(vendorUser, vendorSnapshot.vendorId)),
            },
          },
        },
      }));

      await VendorUser.bulkWrite(bulkOps);
    }

    res.locals.auditDescription = `Updated vendor "${updatedData.vendorName}"`;
    req.flash("notification", "Vendor updated successfully!");
    res.json({ success: true, redirect: "/sachiko/vendor/view" });
  } catch (err) {
    console.error("VENDOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "vendor already exist" });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// Route to handle VENDOR USER form submission
router.post("/form/vendor-user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    const vendor = await Vendor.findOne({ _id: objectId }).lean();
    if (!vendor) {
      return res.status(400).json({ success: false, message: "Invalid vendor selected" });
    }

    const vendorSnapshot = getVendorSnapshot(vendor);
    const vendorId = vendorSnapshot.vendorId;
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );
    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }
    const primaryLocation = locationDetails[0];
    const vendorUserSignature = hashSignature(buildVendorUserSignature(req.body, vendorId));

    // Prevent duplicates only on full identity tuple within the same vendor.
    const duplicateVendorUser = await VendorUser.findOne({
      $or: [
        { vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    const newUser = await VendorUser.create({
      ...req.body,
      ...vendorSnapshot,
      vendorId,
      userName,
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (vendor coordinator view/details) keep working.
      SelfDispatch: primaryLocation.selfDispatch || "",
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      dropLocation1: primaryLocation.dropLocation1 || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      deliveryLocation1: primaryLocation.deliveryLocation1 || "",
      vendorPayment: primaryLocation.vendorPayment || "",
      vendorUserSignature,
    });

    await Vendor.updateOne({ _id: vendor._id }, { $push: { users: newUser._id } });

    res.locals.auditDescription = `Created vendor coordinator "${userName}" for vendor "${vendor.vendorName}"`;
    req.flash("notification", "Vendor user created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/vendor?tab=user" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TTR EDIT =================
// ----------------------------------Sales Order---------------------------------->
// Centralized Sales Order Form
router.get("/sales/order", async (req, res) => {
  const { orderId } = req.query;
  const clientsPromise = Client.distinct("clientName");
  const locationsPromise = Location.distinct("locationName");
  // Full Label Stock master catalog (see /sachiko/label-stock/view) -- the
  // Product Code picker lists every master product, not just ones already
  // bound to the selected client (see onLabelStockProductChange / the
  // labelStockMasterId fallback in POST /sales/order below).
  const labelStocksPromise = SachikoLabelStock.find({}, { skuCode: 1, productCode: 1, rollOrSheet: 1 }).sort({ productCode: 1 }).lean();
  const submissionToken = crypto.randomUUID();

  const orderPromise = orderId
    ? TapeSalesOrder.findById(orderId).populate("userId").populate("tapeId").populate("tapeBinding").lean()
    : Promise.resolve(null);

  const logsPromise = orderId
    ? SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean()
    : Promise.resolve([]);

  const [clients, locations, labelStocks, orderToEdit, logs] = await Promise.all([
    clientsPromise,
    locationsPromise,
    labelStocksPromise,
    orderPromise,
    logsPromise,
  ]);

  let stockInfo = null;
  if (orderToEdit?.tapeId?._id) {
    try {
      stockInfo = await getItemStockSummary(orderToEdit.onModel, orderToEdit.tapeId._id, orderToEdit._id);
    } catch (err) {
      console.error("EDIT ORDER STOCK SUMMARY ERROR:", err);
    }
  }

  res.render("inventory/orders/salesOrderForm.ejs", {
    clients,
    locations: (locations || []).filter(Boolean).sort(),
    labelStocks,
    orderToEdit,
    stockInfo,
    logs,
    submissionToken,
    CSS: false,
    JS: false,
    title: orderToEdit ? "Edit Sales Order" : "Sales Order",
    notification: req.flash("notification"),
  });
});

// API: Get items by type and user
// API: Get clients filtered by item type (for smart filter)
router.get("/sales/clients/:itemType", async (req, res) => {
  try {
    const { itemType } = req.params;

    // LABEL_STOCK (like the "no itemType" case) lists every client, not just
    // ones with an existing LabelStockBinding: the Product Code picker on
    // this same form lists the full master catalog and POST /sales/order
    // auto-creates the binding on submit when one doesn't exist yet (see
    // the labelStockMasterId fallback there), so a first-time client must
    // still be selectable here. TAPE has no such fallback -- its items only
    // ever come from an existing TapeBinding -- so it stays filtered.
    if (itemType !== "TAPE") {
      const clients = await Client.distinct("clientName");
      return res.json(clients.sort());
    }

    const userIds = await TapeBinding.distinct("userId");
    const users = await Username.find({ _id: { $in: userIds } })
      .select("clientName")
      .lean();
    const clientNames = [...new Set(users.map((u) => u.clientName).filter(Boolean))].sort();
    res.json(clientNames);
  } catch (err) {
    console.error("Sales clients filter error:", err);
    res.status(500).json([]);
  }
});

router.get("/sales/items/:type/:userId", async (req, res) => {
  try {
    const { type, userId } = req.params;
    let items = [];

    // Optional location filter: bindings are now tied to a user AND a location,
    // so only surface items bound at the requested location (when provided).
    const normLoc = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
    const locationFilter = normLoc(req.query.location);
    const matchesLocation = (loc) => !locationFilter || normLoc(loc) === locationFilter;

    const user = await Username.findById(userId)
      .populate({
        path: "tape",
        populate: { path: "tapeId" },
      })
      .populate({
        path: "labelStock",
        populate: { path: "labelStock", model: "SachikoLabelStock" },
      })
      .lean();

    if (!user) return res.json([]);

    if (type === "TAPE") {
      const bindings = (user.tape || []).filter((b) => matchesLocation(b.location));
      items = await Promise.all(
        bindings.map(async (binding) => {
          if (!binding.tapeId) return null;
          if (binding.status === "INACTIVE") return null; // disabled binding: not orderable
          const stockInfo = await getItemStockSummary("Tape", binding.tapeId._id);
          const t = binding.tapeId;
          return {
            _id: binding._id,
            location: binding.location || "",
            displayName: `${t.tapePaperCode || ""} - ${t.tapeGsm || ""}gsm`,
            minOrderQty: binding.tapeMinQty || 0,
            rate: binding.tapeRatePerRoll || 0,
            stock: stockInfo,
            details: {
              type: "TAPE",
              productId: t.tapeProductId || "",
              paperCode: t.tapePaperCode || "",
              gsm: t.tapeGsm || "",
              paperType: t.tapePaperType || "",
              adhesiveGsm: t.tapeAdhesiveGsm || "",
              finish: t.tapeFinish || "",
              color: t.tapeColor || "",
              width: t.tapeWidth || "",
              mtrs: t.tapeMtrs || "",
              coreId: t.tapeCoreId || "",
              coreLength: t.tapeCoreLength || "",
              notch: t.tapeNotch || "",
              winding: t.tapeWinding || "",
              clientPaperCode: binding.tapeClientPaperCode || "",
              clientGsm: binding.clientTapeGsm || "",
              deliveredMtrs: binding.tapeMtrsDel || "",
              saleCost: binding.tapeSaleCost || 0,
              minQty: t.tapeMinQty || 0,
              orderQty: binding.tapeOdrQty || 0,
              orderFreq: binding.tapeOdrFreq || "",
              creditTerm: binding.tapeCreditTerm || "",
            },
          };
        }),
      );
    } else if (type === "LABEL_STOCK") {
      const bindings = (user.labelStock || []).filter((b) => matchesLocation(b.location));
      items = bindings.map((binding) => {
        if (!binding.labelStock) return null;
        if (binding.status === "INACTIVE") return null; // disabled binding: not orderable
        const s = binding.labelStock;
        return {
          _id: binding._id,
          location: binding.location || "",
          displayName: s.productCode || "",
          minOrderQty: 0,
          rate: binding.rate ?? 0,
          stock: null,
          paperSize: binding.paperSize || "",
          runningMeters: binding.runningMeters ?? null,
          details: {
            type: "LABEL_STOCK",
            skuCode: s.skuCode || "",
            productCode: s.productCode || "",
            rollType: s.rollType || "NORMAL",
            fsFamily: s.facestock?.facestockFamily || "",
            fsType: s.facestock?.facestockType || "",
            fsGsm: s.facestock?.facestockGsm ?? "",
            fsMicron: s.facestock?.facestockMicron ?? "",
            adType: s.adhesive?.adhesiveType || "",
            adGsm: s.adhesive?.adhesiveGsm ?? "",
            rlType: s.releaseLiner?.releaseLinerType || "",
            rlColor: s.releaseLiner?.releaseLinerColor || "",
            rlGsm: s.releaseLiner?.releaseLinerGsm ?? "",
            fs2Family: s.facestock2?.facestockFamily || "",
            fs2Type: s.facestock2?.facestockType || "",
            fs2Gsm: s.facestock2?.facestockGsm ?? "",
            fs2Micron: s.facestock2?.facestockMicron ?? "",
            ad2Type: s.adhesive2?.adhesiveType || "",
            ad2Gsm: s.adhesive2?.adhesiveGsm ?? "",
            rl2Type: s.releaseLiner2?.releaseLinerType || "",
            rl2Color: s.releaseLiner2?.releaseLinerColor || "",
            rl2Gsm: s.releaseLiner2?.releaseLinerGsm ?? "",
          },
        };
      });
    }

    res.json(items.filter(Boolean));
  } catch (err) {
    console.error("ITEMS API ERROR:", err);
    res.json([]);
  }
});

// Builds a rich audit description for a sales order create/update, naming the
// client, item type, quantity, and PO number (no internal item code).
async function describeSalesOrder({ itemTypeLabel, userId, quantity, poNumber, isUpdate }) {
  const user = await Username.findById(userId).select("clientName userName").lean();
  const client = user?.clientName || "Unknown Client";
  const verb = isUpdate ? "Updated" : "Created";
  const poSuffix = poNumber ? ` (PO ${poNumber})` : "";
  return `${verb} ${itemTypeLabel} sales order for "${client}" x${quantity}${poSuffix}`;
}

// Submit Sales Order (Create or Update)
router.post("/sales/order", async (req, res) => {
  try {
    const { orderId, itemType, userId, itemId, quantity, estimatedDate, remarks, sourceLocation, locationRadio, userLocation, poNumber, poDate, orderRate, submissionToken, paperSize, runningMeters, noOfRolls, labelStockMasterId, itemRate } = req.body;
    const createdByUser = req.user?.username || "SYSTEM";

    if (["TAPE"].includes(itemType) && canonicalizeLocationName(locationRadio) === "ALL") {
      return res.status(400).json({ success: false, message: "Location cannot be ALL. Please select a specific location." });
    }
    let normalizedSourceLocation = canonicalizeLocationName(sourceLocation || locationRadio || userLocation);
    const isStockBasedType = ["TAPE"].includes(itemType);

    // "ALL" is not a valid storage location for stock-based orders.
    if (normalizedSourceLocation === "ALL") normalizedSourceLocation = "";

    // Fallback 1: derive from selected user.
    if (!normalizedSourceLocation && userId) {
      const userDoc = await Username.findById(userId).select("userLocation").lean();
      normalizedSourceLocation = canonicalizeLocationName(userDoc?.userLocation);
    }

    // Fallback 2: derive from binding -> user -> location.
    if (!normalizedSourceLocation && isStockBasedType && itemId) {
      let bindingUserId = null;

      if (itemType === "TAPE") {
        const binding = await TapeBinding.findById(itemId).select("userId").lean();
        bindingUserId = binding?.userId || null;
      }

      if (bindingUserId) {
        const userDoc = await Username.findById(bindingUserId).select("userLocation").lean();
        normalizedSourceLocation = canonicalizeLocationName(userDoc?.userLocation);
      }
    }

    if (isStockBasedType && (!normalizedSourceLocation || normalizedSourceLocation === "ALL")) {
      return res.status(400).json({ success: false, message: "no location is selected" });
    }

    const sourceLocationForSave = normalizedSourceLocation || undefined;

    if (itemType === "TAPE") {
      const binding = await TapeBinding.findById(itemId);
      if (!binding) {
        return res.status(400).json({ success: false, message: "Invalid item selected" });
      }
      if (!orderId && binding.status === "INACTIVE") {
        return res.status(400).json({ success: false, message: "This item is disabled for the selected client and cannot be ordered." });
      }
      const parsedOrderRate = Number(orderRate);
      const finalOrderRate = Number.isFinite(parsedOrderRate) ? parsedOrderRate : Number(binding.tapeRatePerRoll) || 0;

      const data = {
        tapeBinding: itemId,
        userId: binding.userId,
        tapeId: binding.tapeId,
        sourceLocation: sourceLocationForSave, // Allow updating location if needed
        poDate: poDate ? new Date(poDate) : undefined,
        poNumber,
        orderRate: finalOrderRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        status: "PENDING",
        onModel: "Tape",
        onBindingModel: "TapeBinding",
      };

      if (orderId) {
        // UPDATE existing order
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Tape", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: true,
        });
        req.flash("notification", "Sales order updated successfully!");
        res.json({ success: true, redirect: "/sachiko/sales/pending" });
      } else {
        // CREATE new order
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId,
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: sourceLocationForSave,
          orderRate: finalOrderRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/sachiko/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);

        // Action Log entry for creation
        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });

        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Tape", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: false,
        });
        req.flash("notification", "Sales order created successfully!");

        // Redirect to pending orders
        res.json({ success: true, redirect: "/sachiko/sales/pending" });
      }
    } else if (itemType === "LABEL_STOCK") {
      // Validated up front (rather than after binding resolution) so an
      // auto-created binding (below) never gets a blank paperSize/runningMeters.
      const trimmedPaperSize = String(paperSize || "").trim();
      if (!trimmedPaperSize || !runningMeters || !noOfRolls) {
        return res.status(400).json({ success: false, message: "Paper Size, Running Meters, and No of Rolls are required for Label Stock orders." });
      }

      let binding = itemId ? await LabelStockBinding.findById(itemId) : null;

      // A picked binding whose own Paper Size/Running Meters don't match
      // what's actually on this order isn't the right binding to save
      // against -- the Paper Size/RM inputs stay editable after picking an
      // item (they're only auto-filled from it, not locked to it), so a
      // client with one binding at e.g. 500mm/1000m can still be ordered
      // 600mm/1500m of the same product, which is a *different* binding
      // (see LabelStockBinding.bindingSignature). Route that the same way
      // as "no binding was picked at all" -- resolve/create the one that
      // actually matches, rather than silently saving the order under the
      // mismatched binding it was picked from.
      const bindingMatchesOrder = binding
        && String(binding.paperSize || "").trim() === trimmedPaperSize
        && Number(binding.runningMeters) === Number(runningMeters);

      if (!binding || !bindingMatchesOrder) {
        // The Product Code picker lists every Label Stock master product
        // (see /sachiko/label-stock/view), not just ones already bound to
        // this client -- so itemId can come back empty when the picked
        // product has no binding yet. A mismatched existing binding already
        // has a known-valid labelStock master id; a missing one needs it
        // resolved (and validated) from labelStockMasterId instead.
        let masterId;
        if (binding) {
          masterId = String(binding.labelStock);
        } else {
          masterId = String(labelStockMasterId || "").trim();
          if (!masterId) {
            return res.status(400).json({ success: false, message: "Invalid item selected" });
          }
          const master = await SachikoLabelStock.findById(masterId).select("_id").lean();
          if (!master) {
            return res.status(400).json({ success: false, message: "Invalid item selected" });
          }
        }

        const resolved = await resolveLabelStockBinding({
          labelStock: masterId,
          userId,
          paperSize: trimmedPaperSize,
          runningMeters,
          itemRate,
          sourceLocation,
          locationRadio,
          userLocation,
        });
        if (resolved.error) {
          return res.status(400).json({ success: false, message: resolved.error });
        }
        binding = resolved.binding;
      }

      if (!orderId && binding.status === "INACTIVE") {
        return res.status(400).json({ success: false, message: "This item is disabled for the selected client and cannot be ordered." });
      }

      // Rate is editable on the order form even for an already-bound product
      // (see rateDisplayInput in salesOrderForm.ejs) -- a change here is a
      // rate revision for this client+product going forward, not just a
      // one-off for this order, so it's written back onto the binding itself
      // and every future order picks it up the same way a manual edit via
      // /sachiko/label-stock-binding/edit/:id would.
      const submittedRate = Number(itemRate);
      if (Number.isFinite(submittedRate) && submittedRate > 0 && submittedRate !== Number(binding.rate)) {
        binding.rate = submittedRate;
        await binding.save();
      }
      const labelStockRate = Number(binding.rate) || 0;

      const data = {
        tapeBinding: binding._id,
        userId: binding.userId,
        tapeId: binding.labelStock,
        sourceLocation: canonicalizeLocationName(binding.location),
        poDate: poDate ? new Date(poDate) : undefined,
        poNumber,
        orderRate: labelStockRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        paperSize: trimmedPaperSize,
        runningMeters: Number(runningMeters),
        noOfRolls: Number(noOfRolls),
        status: "PENDING",
        onModel: "SachikoLabelStock",
        onBindingModel: "LabelStockBinding",
      };

      if (orderId) {
        // UPDATE existing order
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        await upsertPendingProduction({ _id: orderId, ...data });
        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Label Stock", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: true,
        });
        req.flash("notification", "Sales order updated successfully!");
        res.json({ success: true, redirect: "/sachiko/sales/pending" });
      } else {
        // CREATE new order
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId: String(binding._id),
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: data.sourceLocation,
          orderRate: labelStockRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/sachiko/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);
        await upsertPendingProduction(newOrder);

        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });

        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Label Stock", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: false,
        });
        req.flash("notification", "Sales order created successfully!");
        res.json({ success: true, redirect: "/sachiko/sales/pending" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Unsupported item type" });
    }
  } catch (err) {
    console.error("ORDER SUBMIT ERROR:", err);
    const duplicateSubmissionToken =
      err?.code === 11000 &&
      ((err?.keyPattern &&
        (Object.prototype.hasOwnProperty.call(err.keyPattern, "submissionToken") ||
          Object.prototype.hasOwnProperty.call(err.keyPattern, "orderSignature"))) ||
        (err?.keyValue &&
          (Object.prototype.hasOwnProperty.call(err.keyValue, "submissionToken") ||
            Object.prototype.hasOwnProperty.call(err.keyValue, "orderSignature"))) ||
        String(err?.message || "").includes("submissionToken") ||
        String(err?.message || "").includes("orderSignature"));

    if (duplicateSubmissionToken) {
      return res.json({ success: true, redirect: "/sachiko/sales/pending", duplicate: true });
    }
    // Race between two near-simultaneous submits for the same new-client
    // Label Stock binding: both pass the findOne(bindingSignature) check
    // above before either creates, so the second create() hits the unique
    // index instead (see buildLabelStockBindingSignature / LabelStockBinding
    // schema). Same friendly message the manual binding form gives.
    const duplicateBindingSignature =
      err?.code === 11000 &&
      ((err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "bindingSignature")) ||
        (err?.keyValue && Object.prototype.hasOwnProperty.call(err.keyValue, "bindingSignature")) ||
        String(err?.message || "").includes("bindingSignature"));
    if (duplicateBindingSignature) {
      return res.status(400).json({
        success: false,
        message: "This Label Stock binding already exists (same SKU Code, Paper Size, RM, Client and User).",
      });
    }
    const sourceLocError = err?.errors?.sourceLocation;
    if (sourceLocError) {
      return res.status(400).json({ success: false, message: "no location is selected" });
    }
    res.status(400).json({ success: false, message: "Failed to submit order" });
  }
});

// View Pending Orders
router.get("/sales/pending", async (req, res) => {
  try {
    const pendingOrders = await TapeSalesOrder.find({ status: "PENDING" })
      .select(
        "tapeId tapeBinding userId quantity dispatchedQuantity estimatedDate poDate createdAt sourceLocation poNumber orderRate remarks status onModel onBindingModel paperSize runningMeters noOfRolls",
      )
      .populate({ path: "userId", select: "clientName userName" })
      .populate({
        path: "tapeId",
        // Widened beyond what the table itself needs so the "View" dialog's
        // Fairtech-vs-Client comparison (mirrors /tape/compare/:id,
        // minus the vendor column) has every spec field it displays.
        // Mongoose ignores field names that don't exist on whichever model a
        // given document's onModel actually resolves to, so Tape and
        // SachikoLabelStock fields can share one select string safely.
        select:
          "tapeProductId tapePaperCode tapePaperType tapeGsm tapeWidth tapeMtrs tapeCoreId tapeFinish tapeAdhesiveGsm productCode skuCode rollOrSheet facestock adhesive releaseLiner",
      })
      .populate({
        path: "tapeBinding",
        select:
          "tapeClientPaperCode tapeRatePerRoll tapeOdrQty tapeOdrFreq tapeCreditTerm tapeSaleCost tapeMtrsDel tapeMinQty clientTapeGsm status location",
      })
      .sort({ createdAt: 1 })
      .lean();

    // Group pending orders by model type and itemId to fetch total stock.
    // Only Tape has a stock model at all -- SL rows just get totalStock: 0
    // below without ever touching TapeStock.
    const itemIdsByModel = {
      Tape: new Set(),
    };

    pendingOrders.forEach(o => {
      if (o.onModel === "Tape" && o.tapeId) {
        itemIdsByModel.Tape.add(o.tapeId?._id?.toString());
      }
    });

    const stockMap = {}; // mapping: "onModel:itemId" -> totalStock

    // Fetch stocks in parallel
    const stockPromises = [
      TapeStock.aggregate([
        { $match: { tape: { $in: Array.from(itemIdsByModel.Tape).map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: "$tape", total: { $sum: "$quantity" } } }
      ]),
    ];

    const [tapeStocks] = await Promise.all(stockPromises);

    tapeStocks.forEach(s => stockMap[`Tape:${s._id}`] = s.total);

    // Fetch active Purchase Orders for these items
    const allItemIds = Object.values(itemIdsByModel).flatMap(set => Array.from(set)).map(id => new mongoose.Types.ObjectId(id));
    const activePOs = await PurchaseOrder.find({
      status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
      itemId: { $in: allItemIds }
    }).select("itemId onModel").lean();

    const poItemSet = new Set();
    activePOs.forEach(po => poItemSet.add(`${po.onModel}:${po.itemId}`));

    // Attach totalStock to each order
    pendingOrders.forEach(o => {
      const key = `${o.onModel}:${o.tapeId?._id}`;
      o.totalStock = stockMap[key] || 0;
      o.hasPendingPo = poItemSet.has(key);
    });

    res.render("inventory/orders/pendingOrders.ejs", {
      orders: pendingOrders,
      title: "Pending Orders",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PENDING ORDERS ERROR:", err);
    res.redirect("back");
  }
});

// View Pending Purchase Orders
// Facestock/Adhesive/Release Master have no VendorUser/binding concept the
// way Tape does (see PurchaseOrder model) -- this is the one shared lookup
// table for those three, used to name the item on the Pending/Receive PO
// pages and to know which stock model a received PO creates a reel in.
const MATERIAL_PO_TYPES = {
  FacestockMaster: {
    label: "Facestock",
    name: (item) => (item ? `${item.skuId || ""} — ${item.family || ""} ${item.type || ""}`.trim() : "N/A"),
  },
  AdhesiveMaster: {
    label: "Adhesive",
    name: (item) => (item ? `${item.skuId || ""} — ${item.type || ""}`.trim() : "N/A"),
  },
  ReleaseMaster: {
    label: "Release Liner",
    name: (item) => (item ? `${item.skuId || ""} — ${item.type || ""}`.trim() : "N/A"),
  },
};

router.get("/purchase/pending", async (req, res) => {
  try {
    const pendingPOs = await PurchaseOrder.find({
      status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
      $or: [
        { vendorUserId: { $ne: null }, vendorBinding: { $ne: null } },
        { onModel: { $in: Object.keys(MATERIAL_PO_TYPES) } },
      ],
    })
      .populate("vendorUserId", "vendorName userName")
      .populate({
        path: "itemId",
        select:
          "tapeProductId tapePaperCode tapeGsm ttrProductId ttrType ttrWidth ttrMtrs" +
          " skuId family type size gsm micron make vendorSkuCode shelfLife color msq",
      })
      .sort({ createdAt: -1 })
      .lean();

    const orders = pendingPOs.map((order) => ({
      ...order,
      vendorDisplayName: order.vendorUserId?.vendorName || order.vendorName || "Vendor not binded",
      coordinatorDisplayName: order.vendorUserId?.userName || order.coordinatorName || "Coordinator not binded",
    }));

    res.render("inventory/orders/pendingPurchaseOrders.ejs", {
      title: "Pending Purchase Orders",
      orders,
      notification: req.flash("notification"),
      CSS: "tableDisp.css",
      JS: false,
    });
  } catch (err) {
    console.error("PENDING PO ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

function getItemName(item, type) {
  if (!item) return "N/A";
  if (type === "Tape") return `${item.tapePaperCode || ""} ${item.tapeGsm || ""}gsm`.trim() || item.tapeProductId;
  if (MATERIAL_PO_TYPES[type]) return MATERIAL_PO_TYPES[type].name(item);
  return "N/A";
}

router.get("/purchase/receive", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order ID provided.");
      return res.redirect("/sachiko/purchase/pending");
    }

    const order = await PurchaseOrder.findById(orderId)
      .populate("vendorUserId")
      .populate("itemId")
      .lean();

    if (!order) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/sachiko/purchase/pending");
    }

    const [logs, locations] = await Promise.all([
      PurchaseOrderLog.find({ orderId: orderId, action: { $ne: "CREATED" } })
        .sort({ createdAt: -1 })
        .lean(),
      Location.distinct("locationName")
    ]);

    res.render("inventory/orders/receivePO.ejs", {
      title: "Receive Purchase Order",
      order,
      logs: logs || [],
      locations: (locations || []).filter(Boolean).sort(),
      itemName: getItemName(order.itemId, order.onModel),
      notification: req.flash("notification"),
      CSS: false,
      JS: false
    });
  } catch (err) {
    console.error("RECEIVE PO GET ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/purchase/receive", async (req, res) => {
  try {
    const { orderId, location, receivedQuantity, remarks } = req.body;
    
    const po = await PurchaseOrder.findById(orderId).populate("itemId");
    if (!po) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/sachiko/purchase/pending");
    }

    if (po.status === "RECEIVED") {
      req.flash("notification", "This order has already been received.");
      return res.redirect("/sachiko/purchase/pending");
    }

    const qty = Number(receivedQuantity) || po.quantity;

    // Create Stock Entry based on item type
    if (po.onModel === "Tape") {
      await TapeStock.create({
        tape: po.itemId._id,
        location,
        quantity: qty,
        remarks: remarks || `From PO: ${po.poNumber}`,
        tapeFinish: po.itemId.tapeFinish || "MATTE"
      });
    } else if (po.onModel === "FacestockMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("FACESTOCK", FacestockStock);
      await FacestockStock.create({
        family: item.family,
        type: item.type,
        size: item.size,
        gsm: item.gsm,
        micron: item.micron,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    } else if (po.onModel === "AdhesiveMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("ADHESIVE", AdhesiveStock);
      await AdhesiveStock.create({
        type: item.type,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        shelfLife: item.shelfLife,
        viscosity: item.viscosity,
        cohesion: item.cohesion,
        shear: item.shear,
        density: item.density,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    } else if (po.onModel === "ReleaseMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("RELEASE", ReleaseLinerStock);
      await ReleaseLinerStock.create({
        type: item.type,
        color: item.color,
        size: item.size,
        gsm: item.gsm,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    }

    // Update PO Status & Quantities
    const newlyReceived = qty;
    po.receivedQuantity = (po.receivedQuantity || 0) + newlyReceived;
    
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else {
      po.status = "PARTIALLY_RECEIVED";
    }

    po.remarks = (po.remarks ? po.remarks + " | " : "") + (remarks || `Received ${newlyReceived}`);
    await po.save();

    // Log Action
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: po.status === "RECEIVED" ? "RECEIVED" : "PARTIALLY_RECEIVED",
      poNumber: po.poNumber,
      quantity: newlyReceived,
      location: location,
      remarks: `Inward to ${location}. ` + (remarks || ""),
      performedBy: req.session?.authUser?.username || "SYSTEM"
    });

    res.locals.auditDescription = `Received ${newlyReceived} units into stock at "${location}" for PO "${po.poNumber}"`;
    req.flash("notification", "Purchase Order received and stock updated successfully.");
    res.redirect("/sachiko/purchase/pending");
  } catch (err) {
    console.error("RECEIVE PO POST ERROR:", err);
    req.flash("notification", "Error processing receipt: " + err.message);
    res.redirect("back");
  }
});

// GET: Confirm Order Page (prefilled sales order form + extra fields)
router.get("/sales/order/confirm", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order specified");
      return res.redirect("/sachiko/sales/pending");
    }

    let order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "userId", select: "clientName userName userLocation" })
      .populate({
        path: "tapeId",
        select:
          "tapeProductId tapePaperCode tapeGsm tapeFinish tapePaperType tapeAdhesiveGsm tapeWidth tapeMtrs tapeCoreId ttrProductId ttrType ttrColor ttrMaterialCode ttrWidth ttrMtrs ttrInkFace ttrCoreId ttrCoreLength ttrNotch ttrWinding labelWidth labelHeight productCode skuCode rollType facestock adhesive releaseLiner facestock2 adhesive2 releaseLiner2",
      })
      .populate({
        path: "tapeBinding",
        select:
          "tapeRatePerRoll tapeOdrQty tapeMinQty tapeClientMaterialCode clientTapeGsm ttrRatePerRoll ttrOdrQty ttrMinQty ttrClientMaterialCode clientTtrType location status",
      })
      .lean();

    if (!order) {
      req.flash("notification", "Order not found");
      return res.redirect("/sachiko/sales/pending");
    }

    const logs = await SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean();
    const locations = await Location.distinct("locationName");

    // ========== STOCK PRE-CALCULATION FOR CONFIRM PAGE ==========
    let stockInfo = { totalStock: 0, locations: [], booked: 0, balance: 0 };
    if (order.tapeId) {
      try {
        stockInfo = await getItemStockSummary(order.onModel, order.tapeId._id);
      } catch (err) {
        console.error("CONFIRM STOCK SUMMARY ERROR:", err);
      }
    }

    const clients = await Client.distinct("clientName");

    res.render("inventory/orders/salesOrderForm.ejs", {
      clients,
      locations: (locations || []).filter(Boolean).sort(),
      orderToEdit: order,
      stockInfo, // Pass pre-calculated stock
      logs,
      confirmMode: true,
      CSS: false,
      JS: false,
      title: "Confirm & Create Order",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("CONFIRM ORDER PAGE ERROR:", err);
    req.flash("notification", "Failed to load confirm page");
    res.redirect("/sachiko/sales/pending");
  }
});

// GET: Order Logs
router.get("/sales/order/logs", async (req, res) => {
  try {
    // Step 1: Fetch all logs (without nested populate for now)
    const rawLogs = await SalesOrderLog.find()
      .sort({ performedAt: -1 })
      .lean();

    // Step 2: Collect all orderId values that need to be resolved
    const allOrderIds = [...new Set(rawLogs.map((l) => String(l.orderId)).filter(Boolean))];

    const ITEM_SELECT = "tapeProductId tapePaperCode tapeGsm tapeFinish clientSkuCode productCode skuCode";
    const USER_SELECT = "clientName userName";

    // Step 3: Query the order collection
    const tapeOrders = await TapeSalesOrder.find({ _id: { $in: allOrderIds } })
      .populate({ path: "userId", select: USER_SELECT })
      .populate({ path: "tapeId", select: ITEM_SELECT })
      .lean();

    // Step 4: Build a map of orderId -> populated order doc
    const orderMap = new Map();
    for (const o of tapeOrders) {
      orderMap.set(String(o._id), o);
    }

    // Step 5: Attach the resolved order to each log
    const logs = rawLogs.map((log) => ({
      ...log,
      orderId: orderMap.get(String(log.orderId)) || null,
    }));

    res.render("inventory/orders/orderLogs.ejs", {
      logs,
      title: "Order Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });

  } catch (err) {
    console.error("ORDER LOGS ERROR:", err);
    req.flash("notification", "Failed to load logs");
    res.redirect("/sachiko/sales/pending");
  }
});

// ========== EDIT a Purchase Receipt Log (JSON API) ==========
router.put("/purchase/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, remarks: newRemarks } = req.body;

    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Receipt log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Purchase Order not found" });

    const oldQty = log.quantity || 0;
    const qtyDiff = Number(newQty) - oldQty;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && po.itemId && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff < 0) {
        // Need to reverse (outward) some stock because new quantity is lower
        const deduction = Math.abs(qtyDiff);
        if (currentStock < deduction) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reduce receipt. Available: ${currentStock}, adjustment needed: ${deduction}` });
        }

        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: -deduction,
          remarks: `Receipt Log Edited (reduced): ${po.poNumber}`,
        };
        if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: deduction,
          closingStock: currentStock - deduction,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      } else {
        // Need to inward MORE stock because new quantity is higher
        const addition = qtyDiff;
        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: addition,
          remarks: `Receipt Log Edited (increased): ${po.poNumber}`,
        };
        if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: addition,
          closingStock: currentStock + addition,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      }
    }

    // Update PO totals
    po.receivedQuantity = (po.receivedQuantity || 0) + qtyDiff;
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else if (po.receivedQuantity > 0) {
      po.status = "PARTIALLY_RECEIVED";
    } else {
      po.status = "CONFIRMED"; 
    }
    await po.save();

    // Update Log Record
    log.quantity = Number(newQty);
    if (newRemarks) log.remarks = newRemarks;
    await log.save();

    res.locals.auditDescription = `Edited purchase receipt log for PO "${po.poNumber}" (qty ${oldQty} -> ${newQty})`;
    res.json({ success: true, message: "Receipt log updated successfully" });
  } catch (err) {
    console.error("EDIT PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========== DELETE a Purchase Receipt Log (JSON API) ==========
router.delete("/purchase/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Order not found" });

    const qtyToRemove = log.quantity || 0;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && po.itemId && qtyToRemove > 0) {
      // Reverse stock (outward)
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (currentStock < qtyToRemove) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reverse receipt. Available: ${currentStock}` });
      }

      const stockData = {
        [matchField]: po.itemId._id,
        location,
        quantity: -qtyToRemove,
        remarks: `Receipt Log Deleted (reversed): ${po.poNumber}`,
      };
      if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
      await StockModel.create(stockData);

      await StockLogModel.create({
        [matchField]: po.itemId._id,
        location,
        openingStock: currentStock,
        quantity: qtyToRemove,
        closingStock: currentStock - qtyToRemove,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `Receipt Log Deleted: ${po.poNumber}`,
        createdBy: req.session?.authUser?.username || "SYSTEM"
      });
    }

    // Update PO totals
    po.receivedQuantity = Math.max((po.receivedQuantity || 0) - qtyToRemove, 0);
    if (po.receivedQuantity === 0) {
      po.status = "CONFIRMED";
    } else if (po.receivedQuantity < po.quantity) {
      po.status = "PARTIALLY_RECEIVED";
    }
    await po.save();

    // Remove the Log Entry
    await PurchaseOrderLog.findByIdAndDelete(logId);

    res.locals.auditDescription = `Deleted purchase receipt log for PO "${po.poNumber}" (qty ${qtyToRemove})`;
    res.json({ success: true, message: "Receipt deleted successfully and stock reversed" });
  } catch (err) {
    console.error("DELETE PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET: Purchase Order Logs
router.get("/purchase/order/logs", async (req, res) => {
  try {
    const logs = await PurchaseOrderLog.find()
      .populate({
        path: "orderId",
        populate: [
          { path: "vendorUserId", select: "vendorName userName" },
          {
            path: "itemId",
            select:
              "tapeProductId tapePaperCode tapeGsm ttrProductId ttrType ttrWidth ttrMtrs",
          },
        ],
      })
      .sort({ performedAt: -1 })
      .lean();

    res.render("inventory/orders/purchaseLogs.ejs", {
      logs,
      title: "Purchase Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PURCHASE LOGS ERROR:", err);
    req.flash("notification", "Failed to load purchase logs");
    res.redirect("/sachiko/purchase/pending");
  }
});

// Update Order Status (with stock deduction / reversal + action logging)
router.post("/sales/order/status", requireAuth, updateLimiter, async (req, res) => {
  try {
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    const { orderId, status, cancelReason, invoiceNumber, confirmDate, confirmQuantity, poNumber, sourceLocation } = req.body;
    const confirmRedirectUrl = orderId ? `/sachiko/sales/order/confirm?orderId=${encodeURIComponent(orderId)}` : "/sachiko/sales/pending";
    let order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "tapeId", select: "tapeFinish tapePaperCode tapeGsm" })
      .lean();

    let ActiveOrderModel = TapeSalesOrder;
    let pendingRedirectUrl = "/sachiko/sales/pending";

    if (!order) {
      const message = "Order not found";
      if (wantsJson) return res.status(404).json({ success: false, message });
      req.flash("notification", message);
      return res.redirect(confirmRedirectUrl);
    }

    const previousStatus = order.status;
    console.log(`[DEBUG] Order ${orderId}: Status change ${previousStatus} -> ${status}`);

    if (status === "CONFIRMED") {
      const incomingPo = String(poNumber || "").trim();
      const existingPo = String(order.poNumber || "").trim();
      if (!incomingPo && !existingPo) {
        const message = "PO Number is required before confirming this order.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      const incomingInvoice = String(invoiceNumber || "").trim();
      if (isTemplateOnlyInvoice(incomingInvoice)) {
        const message = "Please enter Invoice Number before submitting the form.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }
    }

    // ========== CONFIRM: Deduct stock ==========
    let finalStatus = status;

    if (status === "CONFIRMED" && previousStatus === "PENDING") {
      const qty = Number(confirmQuantity) || order.quantity;
      const dispatchedSoFar = order.dispatchedQuantity || 0;
      const remaining = order.quantity - dispatchedSoFar;

      if (qty > remaining) {
        const message = `Cannot dispatch ${qty}. Only ${remaining} remaining.`;
        if (wantsJson) {
          return res.status(400).json({ success: false, message });
        }
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      // Label Stock has no stock concept at all -- confirming just logs
      // delivery and updates the dispatched quantity below, skipping every
      // stock read/write.
      if (order.onModel !== "SachikoLabelStock") {
        const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
        const location = canonicalizeLocationName(sourceLocation || order.sourceLocation);

        let StockModel = TapeStock;
        let StockLogModel = TapeStockLog;
        let matchField = "tape";

        if (!location) {
          const message = "Cannot confirm: Source location missing on order";
          if (wantsJson) {
            return res.status(400).json({ success: false, message });
          }
          req.flash("notification", message);
          return res.redirect(confirmRedirectUrl);
        }

        const tape = order.tapeId;

        // Match the confirm-page balance: physical stock minus other pending bookings at this location.
        const [bal, bookedAgg] = await Promise.all([
          StockModel.aggregate([
            { $match: { [matchField]: tapeObjectId, location } },
            { $group: { _id: null, qty: { $sum: "$quantity" } } },
          ]),
          TapeSalesOrder.aggregate([
            {
              $match: {
                tapeId: tapeObjectId,
                status: "PENDING",
                sourceLocation: location,
                _id: { $ne: new mongoose.Types.ObjectId(orderId) },
              },
            },
            {
              $group: {
                _id: null,
                bookedQty: {
                  $sum: { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] },
                },
              },
            },
          ]),
        ]);
        const currentStock = bal[0]?.qty || 0;
        const bookedQty = bookedAgg[0]?.bookedQty || 0;

        // Validate sufficient stock against physical quantity
        if (currentStock < qty) {
          const message = currentStock <= 0
            ? "cannot dispatch, not enough stocks"
            : `Cannot dispatch ${qty}. Only ${currentStock} available at ${location}.`;
          if (wantsJson) {
            return res.status(400).json({ success: false, message });
          }
          req.flash("notification", message);
          return res.redirect(confirmRedirectUrl);
        }

        // Insert negative stock entry (outward)
        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: -qty,
          remarks: `Sales Order Confirmed: ${orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;

        await StockModel.create(stockData);

        // Stock Log entry
        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qty,
          closingStock: currentStock - qty,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Sales Order Confirmed: ${orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }

      // Calculate action time: Use Confirm Date (for date) + Current Time (for time)
      const now = new Date();
      let actionTime = now;
      if (confirmDate) {
        const [y, m, d] = confirmDate.split("-").map(Number);
        actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
      }

      // Action Log entry
      await SalesOrderLog.create({
        orderId,
        action: "DELIVERED",
        invoiceNumber: invoiceNumber || "",
        quantity: qty,
        performedBy: req.user?.username || "SYSTEM",
        performedAt: actionTime,
      });

      // Calculate new dispatched quantity
      const newDispatched = dispatchedSoFar + qty;

      // Determine if fully dispatched
      if (newDispatched >= order.quantity) {
        finalStatus = "CONFIRMED";
      } else {
        finalStatus = "PENDING";
      }

      // Update dispatched quantity immediately to be safe, status will be updated below
      await ActiveOrderModel.findByIdAndUpdate(orderId, { dispatchedQuantity: newDispatched });

      console.log(
        `[DEBUG] Stock deduction + action log successful. Dispatched: ${qty}, Total: ${newDispatched}/${order.quantity}, New Status: ${finalStatus}`,
      );
    } else if (status === "CONFIRMED") {
      console.log(`[DEBUG] Skipping deduction. Status: ${status}, Previous: ${previousStatus}`);
    }

    // ========== CANCEL: Log with reason ==========
    if (status === "CANCELLED" && previousStatus === "PENDING") {
      // Action Log entry for cancel from PENDING
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: order.quantity,
        performedBy: req.user?.username || "SYSTEM",
      });
    }

    // ========== CANCEL a CONFIRMED order: Reverse stock ==========
    if (status === "CANCELLED" && previousStatus === "CONFIRMED") {
      // TODO: Should this be dispatchedQuantity? For now assume cancelling full order if it was fully confirmed. Or partial?
      // If partial dispatch was supported, we really need to know *what* to reverse.
      // But assuming CONFIRMED means *fully* dispatched for now (or at least that's the only state we reverse from).
      // If it's PENDING but partially dispatched, and we cancel... we should reverse dispatchedQuantity.
      const qtyToReverse = order.dispatchedQuantity > 0 ? order.dispatchedQuantity : order.quantity;

      // Label Stock has no stock to reverse -- just log the cancellation and
      // reset dispatched qty below, skipping every stock read/write.
      if (order.onModel !== "SachikoLabelStock") {
        const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
        const location = order.sourceLocation;
        const tape = order.tapeId;

        let StockModel = TapeStock;
        let StockLogModel = TapeStockLog;
        let matchField = "tape";

        // Get current stock at this location
        const bal = await StockModel.aggregate([
          { $match: { [matchField]: tapeObjectId, location } },
          { $group: { _id: null, qty: { $sum: "$quantity" } } },
        ]);
        const currentStock = bal[0]?.qty || 0;

        // Re-add stock (positive entry)
        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: qtyToReverse,
          remarks: `Sales Order Cancelled (reversed): ${orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;

        await StockModel.create(stockData);

        // Stock Log entry
        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qtyToReverse,
          closingStock: currentStock + qtyToReverse,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Sales Order Cancelled (reversed): ${orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }

      // Action Log entry for cancel from CONFIRMED
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: qtyToReverse,
        performedBy: req.user?.username || "SYSTEM",
      });

      // Reset dispatched qty
      await ActiveOrderModel.findByIdAndUpdate(orderId, { dispatchedQuantity: 0 });
    }

    // Update order status and PO number (if submitted on confirm page)
    const updateData = { status: finalStatus };
    if (typeof poNumber !== "undefined") {
      const incomingPo = String(poNumber || "").trim();
      if (incomingPo) updateData.poNumber = incomingPo;
    }
    await ActiveOrderModel.findByIdAndUpdate(orderId, updateData);

    // Keep the Production queue in sync: a Label Stock order re-entering
    // PENDING (partial dispatch) gets upserted back in; anything else
    // (fully confirmed/dispatched, or cancelled) comes off the queue. Plain
    // Tape orders are untouched -- upsertPendingProduction/removePendingProduction
    // no-op for anything that isn't onModel "SachikoLabelStock".
    if (order.onModel === "SachikoLabelStock") {
      if (finalStatus === "PENDING") {
        const freshOrder = await TapeSalesOrder.findById(orderId).lean();
        await upsertPendingProduction(freshOrder);
      } else {
        await removePendingProduction(orderId);
      }
    }

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Updated ${order.onModel} sales order to "${finalStatus}" for "${orderUser?.clientName || "Unknown Client"}" (order ${orderId})`;

    if (finalStatus === "PENDING" && status === "CONFIRMED") {
      req.flash("notification", `Partially dispatched. remaining is pending.`);
    } else if (status === "CANCELLED") {
      req.flash("notification", "order deleted");
    } else {
      req.flash("notification", `Order status updated to ${finalStatus}`);
    }
    if (wantsJson) {
      res.json({ success: true, redirect: pendingRedirectUrl });
    } else {
      res.redirect(pendingRedirectUrl);
    }
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    if (wantsJson) {
      res.status(400).json({ success: false, message: "Failed to update status" });
    } else {
      req.flash("notification", "Failed to update status");
      res.redirect("back");
    }
  }
});

// ========== EDIT a Dispatch Log (JSON API) ==========
router.put("/sales/order/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, invoiceNumber, date } = req.body;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const oldQty = log.quantity;
    const qtyDiff = Number(newQty) - oldQty;
    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && tape && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff > 0) {
        // Need to deduct MORE stock
        if (currentStock < qtyDiff) {
          return res.json({
            success: false,
            message: `Insufficient stock at ${location}. Available: ${currentStock}, Additional needed: ${qtyDiff}`,
          });
        }

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: -qtyDiff,
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qtyDiff,
          closingStock: currentStock - qtyDiff,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      } else {
        // Reverse some stock (qtyDiff is negative, so -qtyDiff is positive)
        const reverseQty = -qtyDiff;

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: reverseQty,
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: reverseQty,
          closingStock: currentStock + reverseQty,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }
    }

    // Update dispatched quantity on the order
    const newDispatched = (order.dispatchedQuantity || 0) + qtyDiff;
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Calculate action time using the provided date + current time
    const now = new Date();
    let actionTime = now;
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
    }

    // Update the log entry
    await SalesOrderLog.findByIdAndUpdate(logId, {
      quantity: Number(newQty),
      invoiceNumber: invoiceNumber || "",
      performedAt: actionTime,
    });

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Edited dispatch log for "${orderUser?.clientName || "Unknown Client"}" (qty ${oldQty} -> ${newQty}, invoice ${invoiceNumber || "-"})`;
    return res.json({ success: true });
  } catch (err) {
    console.error("EDIT LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// ========== DELETE a Dispatch Log (JSON API) ==========
router.delete("/sales/order/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;
    const qty = log.quantity;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    // Reverse stock deduction (add stock back)
    if (location && tape && qty > 0) {
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      const stockData = {
        [matchField]: tapeObjectId,
        location,
        quantity: qty,
        remarks: `Log Deleted (reversed): ${log.orderId}`,
      };
      if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;

      await StockModel.create(stockData);

      const logData = {
        [matchField]: tapeObjectId,
        location,
        openingStock: currentStock,
        quantity: qty,
        closingStock: currentStock + qty,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `Log Deleted (reversed): ${log.orderId}`,
        createdBy: req.user?.username || "SYSTEM",
      };
      await StockLogModel.create(logData);
    }

    // Update dispatched quantity on the order
    const newDispatched = Math.max(0, (order.dispatchedQuantity || 0) - qty);
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Delete the log entry
    await SalesOrderLog.findByIdAndDelete(logId);

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Deleted dispatch log for "${orderUser?.clientName || "Unknown Client"}" (qty ${qty})`;
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// Legacy route redirect
router.get("/form/salesorder", (req, res) => {
  res.redirect("/sachiko/sales/order");
});

// ----------------------------------Sales Calculator---------------------------------->
// route for salescalc form.
router.get("/form/salescalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/salesCalc.ejs", {
    clients,
    title: "Sales Calculator",
    JS: "salesCalc.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle salescalc form submission.
router.post("/form/salescalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Sales Calculation created successfully!");
});

// ----------------------------------Production Calculator---------------------------------->
router.get("/form/prodcalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/prodCalc.ejs", {
    title: "Production Calculator",
    CSS: false,
    JS: "prodCalc.js",
    clients,
    notification: req.flash("notification"),
  });
});

router.get("/form/prodcalc/data", async (req, res) => {
  let { w, h, client } = req.query;
  let clients = await Calculator.findOne({ companyName: client, labelWidth: w, labelHeight: h });
  res.status(200).json(clients);
});

router.post("/form/prodcalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Production Calculation created successfully!");
});

// ----------------------------------Production Binding View---------------------------------->
// "Prod Bind View" -- a read-only browse of what's been saved via Prod
// Binding above. FAIRTECH split a dedicated ProductionBinding entity (with
// die/block/vendor-paper matching) out of this same calculator collection;
// that entity models FAIRTECH's die-cut label production and has no
// equivalent here (Sachiko's Label Stock orders carry their own material
// spec already -- see CLAUDE.md's Assign Production section), so this stays
// a plain list/detail view over the schemaless Calculator collection instead.
router.get("/prodcalc/view", async (req, res) => {
  const entries = await Calculator.find({}).sort({ _id: -1 }).lean();
  const jsonData = entries.map((e) => ({
    ...e,
    _id: String(e._id),
    createdAt: e._id.getTimestamp(),
  }));

  res.render("utilities/prodCalcView.ejs", {
    title: "Production Binding View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/prodcalc/details/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid production binding id.");
    return res.redirect("/sachiko/prodcalc/view");
  }

  const doc = await Calculator.findById(req.params.id).lean();
  if (!doc) {
    req.flash("notification", "Production binding not found.");
    return res.redirect("/sachiko/prodcalc/view");
  }

  const binding = { ...doc, _id: String(doc._id), createdAt: doc._id.getTimestamp() };

  res.render("utilities/prodCalcDetail.ejs", {
    title: "Production Binding Details",
    CSS: "tableDisp.css",
    JS: false,
    binding,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Pending / WIP Production---------------------------------->
// Live-synced off Label Stock orders by utils/pendingProduction.js -- see
// CLAUDE.md's "Production pipeline" section for the full order -> assign ->
// job card lifecycle.

// Every JobCard is write-once, so "live" here just means "poll and pick up
// the fact a card now exists" -- see GET /labels/production/wip-progress.
async function buildJobCardProgressMap(pendingIds) {
  if (!pendingIds.length) return new Map();
  const cards = await MachineJobCard.find({ pendingProductionId: { $in: pendingIds } })
    .select("pendingProductionId jobCardId totalMeter updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  const map = new Map();
  cards.forEach((card) => {
    const key = String(card.pendingProductionId);
    if (!map.has(key)) map.set(key, { jobCardId: card.jobCardId, totalMeter: card.totalMeter, updatedAt: card.updatedAt });
  });
  return map;
}

router.get("/labels/production/pending", async (req, res) => {
  const initialTab = req.query.tab === "wip" ? "wip" : "pending";

  const all = await PendingProduction.find({})
    .populate("userId", "clientName userName clientType")
    .populate("itemId", "productCode skuCode rollType")
    .populate("assignedMachineId", "machineName machineType")
    .populate("operatorId", "empName")
    .populate("helperId", "empName")
    .sort({ createdAt: -1 })
    .lean();

  let jobCardProgress = new Map();
  if (initialTab === "wip") {
    const wipIds = all.filter((r) => r.assignedMachineId).map((r) => r._id);
    jobCardProgress = await buildJobCardProgressMap(wipIds);
  }

  const mapped = all.map((r) => {
    const item = r.itemId || {};
    // Same rollsStatus classification as routes/system/machine.js's
    // buildQueueRows -- lets the WIP tab flag an order that was assigned to
    // a machine without (or without enough) raw material allocated, since
    // Assign Production no longer blocks on short stock.
    const rollsRequired = r.noOfRolls != null ? Number(r.noOfRolls) : null;
    const rollsAllotted = r.allottedRolls != null ? Number(r.allottedRolls) : null;
    const rollsStatus =
      rollsAllotted == null || rollsRequired == null
        ? null
        : rollsAllotted === rollsRequired
        ? "match"
        : rollsAllotted < rollsRequired
        ? "short"
        : "over";

    // "Not allocated" should mean the raw materials (Facestock/Adhesive/
    // Release Liner, ...) aren't allotted -- not "fewer Deckle reels have
    // been laminated than rolls were ordered" (rollsStatus above). A single
    // Assign & Continue only ever produces one Deckle, so an order needing
    // 2+ rolls reads "short" on rollsStatus right after its very first,
    // fully-allocated run -- material allocation is the real ready/not-ready
    // signal (see routes/system/machine.js's buildQueueRows for the same
    // split, used by the machine queue this WIP tab links out to).
    const requiredLayers = requiredLayersFor(item.rollType);
    const materialStatus = requiredLayers.length === 0
      ? null
      : requiredLayers.every((key) => !!r.allottedLayers?.[key])
      ? "match"
      : "short";

    // Same allotment facts as materialStatus above, split per raw-material
    // pool (Facestock/Adhesive/Release Liner) instead of collapsed into one
    // yes/no -- DOUBLE FACESTOCK/DOUBLE RELEASE rollTypes call for 2 layers
    // out of the same pool (facestock+facestock2, or adhesive+adhesive2 /
    // releaseLiner+releaseLiner2), so "one of two allotted" needs its own
    // "partial" state distinct from "none" and "full".
    const poolStatus = (pool) => {
      const keys = requiredLayers.filter((key) => LAYER_META[key].pool === pool);
      if (keys.length === 0) return null;
      const allottedCount = keys.filter((key) => !!r.allottedLayers?.[key]).length;
      if (allottedCount === 0) return "none";
      if (allottedCount === keys.length) return "full";
      return "partial";
    };
    const facestockStatus = poolStatus("facestock");
    const adhesiveStatus = poolStatus("adhesive");
    const releaseStatus = poolStatus("release");

    return {
      _id: String(r._id),
      productCode: item.productCode || item.skuCode || "—",
      clientName: r.userId?.clientName || r.userId?.userName || "—",
      userName: r.userId?.userName || "—",
      clientType: r.userId?.clientType || "",
      paperSize: r.paperSize || "—",
      noOfRolls: r.noOfRolls ?? "—",
      allottedRolls: rollsAllotted,
      rollsStatus,
      materialStatus,
      facestockStatus,
      adhesiveStatus,
      releaseStatus,
      quantity: r.quantity,
      balance: Math.max((Number(r.quantity) || 0) - (Number(r.dispatchedQuantity) || 0), 0),
      machineName: r.assignedMachineId?.machineName || "",
      assignedMachineId: r.assignedMachineId ? { _id: String(r.assignedMachineId._id) } : null,
      operatorName: r.operatorId?.empName || "",
      helperName: r.helperId?.empName || "",
      poNumber: r.poNumber || "—",
      estimatedDate: r.estimatedDate,
      remarks: r.remarks || "",
      producedAt: r.producedAt || null,
      createdAt: r.createdAt,
      assignedAt: r.assignedAt || null,
      liveUpdate: jobCardProgress.get(String(r._id)) || null,
    };
  });

  // A row leaves Pending the moment assignedMachineId is set (Assign
  // Production), and only leaves this page entirely once removePendingProduction
  // deletes it after confirm/dispatch/cancel.
  const orders = mapped.filter((r) => !r.assignedMachineId);
  const wipOrders = mapped
    .filter((r) => r.assignedMachineId)
    .sort((a, b) => new Date(b.estimatedDate || 0) - new Date(a.estimatedDate || 0));

  res.render("inventory/orders/pendingProduction.ejs", {
    title: initialTab === "wip" ? "WIP Production" : "Pending Production",
    CSS: "tableDisp.css",
    JS: false,
    orders,
    wipOrders,
    initialTab,
    notification: req.flash("notification"),
  });
});

// Polled by the WIP table to refresh the "Live Update" column without a
// full reload.
router.get("/labels/production/wip-progress", async (req, res) => {
  try {
    const wipIds = await PendingProduction.find({ assignedMachineId: { $ne: null } }).distinct("_id");
    const progress = await buildJobCardProgressMap(wipIds);
    res.json(wipIds.map((id) => ({ _id: String(id), liveUpdate: progress.get(String(id)) || null })));
  } catch (err) {
    console.error("WIP PROGRESS ERROR:", err);
    res.status(500).json([]);
  }
});

const formatLotNo = (seq) => `SP | LOT | ${String(seq).padStart(4, "0")}`;

// Read-only preview of the next lot no -- the number isn't consumed until an
// order is actually assigned.
async function previewNextLotNo() {
  const counter = await Counter.findOne({ key: "sachikoProductionLotNo" }).select("seq").lean();
  return formatLotNo(Number(counter?.seq || 0) + 1);
}

// Claims the next lot no for real, skipping any candidate already held by an
// order or a job card (guards against a pre-existing manually-assigned lot
// no colliding with the counter).
async function generateLotNo() {
  const maxAttempts = 10000;
  for (let i = 0; i < maxAttempts; i++) {
    const counter = await Counter.findOneAndUpdate(
      { key: "sachikoProductionLotNo" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = formatLotNo(counter.seq);
    const [heldByOrder, onJobCard] = await Promise.all([
      PendingProduction.exists({ lotNo: candidate }),
      MachineJobCard.exists({ lotNo: candidate }),
    ]);
    if (!heldByOrder && !onJobCard) return candidate;
  }
  throw new Error("Unable to generate a unique lot no");
}

// ----------------------------------Assign Production---------------------------------->
// No ProductionBinding/die gate here (see the Prod Bind View comment above) --
// this goes straight from Pending Production to machine/operator/roll
// assignment, budgeted against the order's own paperSize/runningMeters/
// noOfRolls (collected at Sales Order entry for Label Stock orders).
router.get("/labels/production/assign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect("/sachiko/labels/production/pending");
    }

    const pendingProduction = await PendingProduction.findById(id)
      .populate("userId", "clientName userName userContact")
      .populate("itemId", "labelStockId skuCode productCode rollType facestock adhesive releaseLiner facestock2 adhesive2 releaseLiner2")
      .lean();

    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect("/sachiko/labels/production/pending");
    }

    const order = await TapeSalesOrder.findById(id).select("poDate").lean();

    const [allMachines, operatorEmployees, helperEmployees] = await Promise.all([
      Machine.find().populate("location").sort({ machineName: 1 }).lean(),
      Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
      Employee.find({ isActive: true, empProfile: "HELPER" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
    ]);

    const previewLotNo = pendingProduction.lotNo || (await previewNextLotNo());

    res.render("inventory/orders/assignProduction.ejs", {
      title: "Assign Production",
      CSS: "tableDisp.css",
      JS: false,
      pp: pendingProduction,
      poDate: order?.poDate || null,
      allMachines,
      operatorEmployees,
      helperEmployees,
      previewLotNo,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("ASSIGN PRODUCTION LOAD ERROR:", err);
    req.flash("notification", "Failed to load Assign Production.");
    res.redirect("/sachiko/labels/production/pending");
  }
});

router.post("/labels/production/assign/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect("/sachiko/labels/production/pending");
    }

    const pendingProduction = await PendingProduction.findById(id);
    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect("/sachiko/labels/production/pending");
    }

    const { machineId, operatorId, helperId, selectedRolls, rawLayers } = req.body;
    const rawProduceMtrs = Number(req.body.rawProduceMtrs);

    if (!machineId || !mongoose.isValidObjectId(machineId)) {
      req.flash("notification", "Please select a valid machine.");
      return res.redirect(`/sachiko/labels/production/assign/${id}`);
    }
    const machine = await Machine.findById(machineId).populate("location").lean();
    if (!machine) {
      req.flash("notification", "Please select a valid machine.");
      return res.redirect(`/sachiko/labels/production/assign/${id}`);
    }

    let operator = null;
    if (operatorId) {
      if (!mongoose.isValidObjectId(operatorId) || !(operator = await Employee.findById(operatorId).select("_id").lean())) {
        req.flash("notification", "Please select a valid operator.");
        return res.redirect(`/sachiko/labels/production/assign/${id}`);
      }
    }
    let helper = null;
    if (helperId) {
      if (!mongoose.isValidObjectId(helperId) || !(helper = await Employee.findById(helperId).select("_id").lean())) {
        req.flash("notification", "Please select a valid helper.");
        return res.redirect(`/sachiko/labels/production/assign/${id}`);
      }
    }

    // Re-verify each ticked roll is real, in-stock, and not already claimed by
    // another machine-assigned order (race-guard against stale page state).
    const submittedRollIds = (Array.isArray(selectedRolls) ? selectedRolls : selectedRolls ? [selectedRolls] : [])
      .filter((rid) => mongoose.isValidObjectId(rid));
    const validRollIds = submittedRollIds.length
      ? await MaterialStock.find({ _id: { $in: submittedRollIds }, quantity: { $gt: 0 } }).distinct("_id")
      : [];
    const takenAgg = validRollIds.length
      ? await PendingProduction.find({
          allottedRollIds: { $in: validRollIds },
          assignedMachineId: { $ne: null },
          _id: { $ne: pendingProduction._id },
        }).select("allottedRollIds").lean()
      : [];
    const takenSet = new Set(takenAgg.flatMap((p) => (p.allottedRollIds || []).map(String)));
    const allottedRollIds = validRollIds.filter((rid) => !takenSet.has(String(rid)));

    // Facestock/Adhesive/Release Liner columns on the assign form let the
    // operator pick raw-material reels straight from this page (see
    // assignProduction.ejs) -- if any were picked, laminate them into a new
    // Deckle now, at the machine's own location, for exactly the mtrs
    // submitted, then fold that new reel in with whatever existing Deckle
    // stock was ticked above.
    //
    // Raw material being short (missing reels, a reel too small, no location
    // on the machine, ...) must NOT block the assignment itself -- the order
    // still needs to land on the machine's queue (as a "short allotted" row,
    // see routes/system/machine.js's buildQueueRows/rollsStatus) so it's
    // visible and can be topped up later by re-opening this same page once
    // material is available. Only a genuinely bad submission (invalid
    // machine/operator/helper, checked above) rejects outright.
    const location = machine.location?.locationName;
    const labelStock = await SachikoLabelStock.findById(pendingProduction.itemId).lean();
    const required = labelStock ? requiredLayersFor(labelStock.rollType) : [];

    // Reels already claimed by another still-open WIP order's own raw-
    // material picks -- a physical reel/drum can only be mounted on one
    // machine at a time, so once ANY other order holds it (assigned to a
    // machine, not yet produced), it can't also land on this order. Same
    // "race-guard against stale page state" the selectedRolls/takenSet check
    // above already does for finished Deckle rolls; this is its counterpart
    // for raw facestock/adhesive/release liner reels. Scoped to producedAt:
    // null, same as loadAllottedByKey (routes/stock/facestockStock.js etc.)
    // -- once an order has actually finished drawing from a reel, whatever
    // is physically left on it goes back to being free stock, not locked to
    // that (now complete) order forever.
    const otherPendingLayers = await PendingProduction.find({
      assignedMachineId: { $ne: null },
      producedAt: null,
      _id: { $ne: pendingProduction._id },
      allottedLayers: { $ne: null },
    }).select("allottedLayers").lean();
    const claimedKeySet = new Set(
      otherPendingLayers.flatMap((p) =>
        Object.values(p.allottedLayers || {})
          .filter((pick) => pick?.pool)
          .flatMap((pick) => pickStockIds(pick).map((sid) => `${pick.pool}|${sid}`)),
      ),
    );

    // Record whichever raw-material layer reels were picked on the assign
    // form, independent of whether every layer got picked -- lets the
    // machine queue show allocation per material (Facestock/Adhesive/
    // Release Liner, ...) rather than only the all-or-nothing Deckle count
    // further down. A layer's checkboxes (assignProduction.ejs) can submit
    // more than one reel now -- e.g. combining two undersized drums onto one
    // order -- so `rawLayers[key]` may be a single id or an array of them.
    // Existence-checked against the right pool model so a stale/tampered id
    // can't leave a broken reference on the order, and dropped (left
    // unallotted) if another order already claimed it.
    let allottedLayers = {};
    const pickedForThisOrder = new Set();
    for (const key of required) {
      const meta = LAYER_META[key];
      const submitted = rawLayers?.[key];
      const candidateIds = [...new Set((Array.isArray(submitted) ? submitted : submitted ? [submitted] : [])
        .filter((sid) => mongoose.isValidObjectId(sid))
        .filter((sid) => !claimedKeySet.has(`${meta.pool}|${sid}`)))];
      if (!candidateIds.length) continue;
      const { Model } = POOL_MODELS[meta.pool];
      const existingIds = new Set((await Model.find({ _id: { $in: candidateIds } }).distinct("_id")).map(String));
      const validIds = candidateIds.filter((sid) => existingIds.has(String(sid)));
      if (validIds.some((sid) => pickedForThisOrder.has(`${meta.pool}|${sid}`))) {
        req.flash("notification", "The same raw-material reel or drum cannot be allotted to more than one layer.");
        return res.redirect(`/sachiko/labels/production/assign/${id}`);
      }
      validIds.forEach((sid) => pickedForThisOrder.add(`${meta.pool}|${sid}`));
      if (validIds.length) allottedLayers[key] = { pool: meta.pool, stockIds: validIds.map(String) };
    }

    // A layer can hold several reels at once, and the operator can laminate
    // any one of them against any one of another layer's -- so two facestock
    // + two adhesive + two release liner reels aren't one recipe, they're
    // eight possible ones. Each combination that differs from this SKU's own
    // stored recipe (a substituted vendor, a different Size, ... -- the
    // fields POOL_MATCH_FIELDS deliberately doesn't pin down) is materially a
    // different label stock, so it's registered now as its own "-A"/"-B"/...
    // Product Code variant, instead of being discovered one at a time later
    // as Deckles get laminated. See trackAllottedCombinations.
    //
    // Never blocks the assignment: same rule as raw material being short
    // below -- the order still has to land on the machine's queue.
    let trackedVariants = null;
    let variantWarning = null;
    try {
      trackedVariants = await trackAllottedCombinations({ labelStock, allottedLayers });
    } catch (variantErr) {
      console.error("LABEL STOCK COMBINATION TRACKING ERROR:", variantErr);
      variantWarning = variantErr.userMessage || variantErr.message || "failed to check material combinations";
    }
    const newVariantCodes = trackedVariants?.created || [];

    let deckleId = null;
    let variantProductCode = null;
    let stockWarning = null;
    if (rawProduceMtrs > 0) {
      const layersPicked = required.length > 0 && required.every((key) => rawLayers && rawLayers[key]);

      if (!location) {
        stockWarning = "the selected machine has no location set";
      } else if (!layersPicked) {
        stockWarning = "not every raw-material layer has a reel selected";
      } else {
        try {
          const produced = await produceDeckle({
            labelStock,
            location,
            reelMtrs: rawProduceMtrs,
            layers: rawLayers,
            createdBy: req.user?.username || "SYSTEM",
            // Stamps the reel as this order's own work, so sending the order
            // back to Pending can un-make it (dissolveDeckle) and leave any
            // Deckle merely ticked on from existing stock alone.
            producedFor: id,
          });
          deckleId = produced.deckleId;
          variantProductCode = produced.variantProductCode;
          allottedRollIds.push(new mongoose.Types.ObjectId(produced.stockId));
        } catch (produceErr) {
          stockWarning = produceErr.message || "failed to produce label stock";
        }
      }
    }

    const lotNo = pendingProduction.lotNo || (await generateLotNo());

    await PendingProduction.findByIdAndUpdate(id, {
      $set: {
        assignedMachineId: machineId,
        operatorId: operator ? operatorId : null,
        helperId: helper ? helperId : null,
        allottedRolls: allottedRollIds.length,
        allottedRollIds,
        allottedLayers,
        lotNo,
        assignedAt: new Date(),
      },
    });

    // Reported alongside whatever the assignment itself did, not instead of
    // it -- minting these variants is a side effect of the reels picked, and
    // whoever assigned the order is the one who needs to know it happened.
    const variantNote = variantWarning
      ? ` Note: the allotted material combinations couldn't be checked against Label Stock (${variantWarning}).`
      : newVariantCodes.length
        ? ` Note: ${newVariantCodes.length === 1 ? "one combination" : `${newVariantCodes.length} combinations`} of the allotted reels`
          + ` don't match this SKU's own spec (e.g. a different vendor) -- added to Label Stock as`
          + ` ${newVariantCodes.length === 1 ? "variant" : "variants"} ${newVariantCodes.map((c) => `"${c}"`).join(", ")}.`
          + (trackedVariants?.truncated ? " Some further combinations were left untracked (too many to enumerate)." : "")
        : "";

    res.locals.auditDescription = `Assigned production order ${id} to machine ${machineId}`
      + (deckleId ? ` (produced Deckle ${deckleId}${variantProductCode ? `, tracked as variant ${variantProductCode}` : ""})` : stockWarning ? " (stock not fully allocated)" : "")
      + (newVariantCodes.length ? ` (label stock variants added: ${newVariantCodes.join(", ")})` : "");
    req.flash("notification", (deckleId
      ? `Machine assigned — Deckle ${deckleId} produced.`
        + (variantProductCode ? ` Note: the raw material picked doesn't exactly match this SKU's own spec (e.g. a different vendor) -- tracked as variant "${variantProductCode}" instead of plain ${labelStock?.productCode || "this SKU"}.` : "")
      : stockWarning
        ? `Machine assigned, but stock wasn't allocated (${stockWarning}) — this order is on the queue as short-allotted. Re-open it to produce a Deckle once material is available.`
        : "Machine assigned successfully.") + variantNote);
    res.redirect("/sachiko/machine/queue");
  } catch (err) {
    console.error("ASSIGN PRODUCTION SAVE ERROR:", err);
    req.flash("notification", "Failed to assign production.");
    res.redirect(`/sachiko/labels/production/assign/${req.params.id}`);
  }
});

router.post("/labels/production/unassign/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect("/sachiko/labels/production/pending?tab=wip");
    }

    const pendingProduction = await PendingProduction.findById(id).lean();
    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect("/sachiko/labels/production/pending?tab=wip");
    }
    if (!pendingProduction.assignedMachineId) {
      req.flash("notification", "This order isn't assigned to a machine.");
      return res.redirect("/sachiko/labels/production/pending?tab=wip");
    }
    // The Deckle's own mtrs only leave when a Job Card is filed, so a filed
    // card can't be undone from here.
    if (pendingProduction.producedAt) {
      req.flash("notification", "A Job Card has already been filed for this order — it can't be sent back to Pending. Cancel it instead if it needs to stop.");
      return res.redirect("/sachiko/labels/production/pending?tab=wip");
    }

    // Raw material, though, left stock the moment Assign & Continue laminated
    // it (produceDeckle). Unassigning gives the order's material back, so those
    // Deckles are un-made and their facestock/adhesive/release liner returned
    // to the reels they came off -- otherwise the raw stock stays spent and an
    // orphan Deckle nobody ordered is left sitting in Finished stock. Only
    // reels this order actually produced are touched; a Deckle merely ticked
    // onto the order from existing stock is simply released below.
    const producedHere = await MaterialStock.find({ producedFor: id }).select("_id rollId").lean();
    const dissolved = [];
    const kept = [];
    for (const reel of producedHere) {
      try {
        const result = await dissolveDeckle({
          stockId: reel._id,
          createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
        });
        dissolved.push(result);
      } catch (dissolveErr) {
        // A Deckle that's already been drawn from can't be returned. Say so
        // and leave it standing rather than failing the whole unassign -- the
        // order still needs to come off the machine.
        kept.push(`${reel.rollId} (${dissolveErr.message})`);
      }
    }

    // lotNo is deliberately kept -- it's tied to the order's life, not the
    // assignment, so a re-assignment reuses it.
    await PendingProduction.findByIdAndUpdate(id, {
      $set: { assignedMachineId: null, operatorId: null, helperId: null, allottedRollIds: [] },
      $unset: { allottedRolls: "", assignedAt: "", allottedLayers: "" },
    });

    res.locals.auditDescription = `Sent production order ${id} back to Pending`;
    let message = "Order sent back to Pending Production.";
    if (dissolved.length) {
      const mtrs = dissolved.reduce((sum, d) => sum + d.mtrs, 0);
      message += ` ${dissolved.length} Deckle${dissolved.length === 1 ? "" : "s"} un-made — ${mtrs} mtrs returned to raw stock.`;
      const missing = [...new Set(dissolved.flatMap((d) => d.missing))];
      if (missing.length) message += ` Note: reel${missing.length === 1 ? "" : "s"} ${missing.join(", ")} no longer exist, so that material couldn't be returned.`;
    }
    if (kept.length) message += ` Note: could not return ${kept.join("; ")}.`;
    req.flash("notification", message);
    res.redirect("/sachiko/labels/production/pending");
  } catch (err) {
    console.error("UNASSIGN PRODUCTION ERROR:", err);
    req.flash("notification", "Failed to send order back to Pending.");
    res.redirect("/sachiko/labels/production/pending?tab=wip");
  }
});

// Admin/HOD only — records of every mutating action + login/logout across the app.
router.get("/audit/view", async (req, res) => {
  const role = req.session?.authUser?.role;
  if (role !== "proprietor" && role !== "admin" && role !== "hod") {
    req.flash("notification", "Access denied");
    return res.redirect("/sachiko/welcome");
  }

  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(5000).lean();

  res.render("system/auditLog.ejs", {
    title: "Audit Log",
    CSS: "tableDisp.css",
    JS: false,
    jsonData: logs,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Block Master---------------------------------->
// route for systemid form.
router.get("/form/block", async (req, res) => {
  let clients = await Client.distinct("clientName");
  console.log(clients);
  res.render("utilities/blockMaster.ejs", {
    CSS: false,
    title: "Block",
    JS: false,
    clients,
    notification: req.flash("notification"),
  });
});

// Route to handle systemid form submission.
router.post("/form/block", requireAuth, createLimiter, async (req, res) => {
  try {
    let formData = req.body;
    await Block.create(formData);
    res.locals.auditDescription = `Created block "${formData.blockNo}"`;
    req.flash("notification", "Block created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/block" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Die Master---------------------------------->

/* ================= DIE ATTACHMENTS (JPG / DESIGN / LAYOUT) ================= */
const DIE_UPLOAD_DIR = path.join(process.cwd(), "images", "dies");
fs.mkdirSync(DIE_UPLOAD_DIR, { recursive: true });

const DIE_FILE_RULES = {
  dieJpgFile: { exts: [".jpg", ".jpeg"], label: "JPG" },
  dieDesignFile: { exts: [".jpg", ".jpeg", ".pdf", ".cdr"], label: "Design" },
  dieLayoutFile: { exts: [".jpg", ".jpeg", ".pdf", ".cdr"], label: "Layout" },
};

const dieStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIE_UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname).toLowerCase()),
});

const dieFileFilter = (req, file, cb) => {
  const rule = DIE_FILE_RULES[file.fieldname];
  if (!rule) return cb(new Error("Invalid upload field"));
  const ext = path.extname(file.originalname).toLowerCase();
  if (!rule.exts.includes(ext)) {
    return cb(new Error(`${rule.label} field accepts ${rule.exts.join(", ")} only`));
  }
  cb(null, true);
};

const dieUpload = multer({
  storage: dieStorage,
  fileFilter: dieFileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
}).fields([
  { name: "dieJpgFile", maxCount: 1 },
  { name: "dieDesignFile", maxCount: 1 },
  { name: "dieLayoutFile", maxCount: 1 },
]);

// Multer wrapper: turn upload errors into clean JSON responses.
const handleDieUpload = (req, res, next) => {
  dieUpload(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "File too large (max 25MB)." : err.message || "File upload failed.";
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

// Remove any files multer already wrote (used when we bail out after upload).
const cleanupDieUploads = (files = {}) => {
  Object.values(files)
    .flat()
    .forEach((file) => {
      if (file?.path) fs.promises.unlink(file.path).catch(() => {});
    });
};

// Compress an uploaded JPG in place (resize + re-encode) to optimize storage.
const optimizeDieJpg = async (filePath) => {
  try {
    const buffer = await sharp(filePath)
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    await fs.promises.writeFile(filePath, buffer);
  } catch (err) {
    console.error("DIE JPG OPTIMIZE ERROR:", err);
  }
};

// Die lineage helpers: a "replace" (physically new tool, same spec) keeps the
// base Die No but appends a " | <LETTER>" suffix (A, B, C...) so replacement
// instances are distinguishable, while a "version" (spec revision) keeps the
// Die No completely unchanged. rootDieNo strips any existing letter suffix so
// replacing a replacement appends the next letter instead of stacking suffixes.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rootDieNo = (dieNo) => String(dieNo || "").replace(/ \| [A-Z]$/, "");
async function nextReplaceLetter(root) {
  const docs = await Die.find({ dieDieNo: { $regex: `^${escapeRegExp(root)}` } })
    .select("dieDieNo")
    .lean();
  const re = new RegExp(`^${escapeRegExp(root)} \\| ([A-Z])$`);
  let maxCode = 0;
  for (const d of docs) {
    const m = String(d.dieDieNo).match(re);
    if (m) maxCode = Math.max(maxCode, m[1].charCodeAt(0) - 64);
  }
  return String.fromCharCode(65 + maxCode);
}

// Duplicate-prevention signature: identifies "the same physical die" purely
// by spec, WITHOUT the generated Die No / version — otherwise two dies with
// identical specs but different auto-generated numbers (the actual bug
// reported: same spec re-entered as a brand-new Die No) would never match.
// Because of that, an intentional "Replace"/"New Version" (which deliberately
// keeps the same spec) DOES collide with its own lineage's signature — the
// duplicate check below excludes the die's own lineage (see lineageDieIds)
// so only a match OUTSIDE that lineage counts as a real duplicate.
function normalizeDiePart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toUpperCase();
}
function normalizeDieList(value) {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return arr.map((v) => normalizeDiePart(v)).filter(Boolean).sort().join(",");
}
function buildDieSignature(source) {
  return [
    normalizeDiePart(source.dieType),
    normalizeDiePart(source.dieMake),
    normalizeDiePart(source.dieBladType),
    normalizeDieList(source.dieMachineNo),
    normalizeDieList(source.dieFamily),
    normalizeDiePart(source.dieTeeth),
    normalizeDiePart(source.dieWidth),
    normalizeDiePart(source.dieHeight),
    normalizeDiePart(source.dieActualWidth),
    normalizeDiePart(source.dieActualHeight),
    normalizeDiePart(source.dieActualRepGap),
    normalizeDiePart(source.dieFlatAcrossGap),
    normalizeDiePart(source.dieFlatrepGap),
    normalizeDiePart(source.dieFlatAcross),
    normalizeDiePart(source.dieFlatDown),
    normalizeDiePart(source.dieTotalUps),
    normalizeDiePart(source.diePapType),
    normalizeDiePart(source.dieOwnedBy),
    normalizeDiePart(source.dieClientName),
  ].join("||");
}

// Every die sharing the same root Die No (the original plus every "Replace"
// letter-suffix instance, across all their versions) — excluded as a group
// from the duplicate check so continuing that lineage never self-collides.
async function lineageDieIds(dieDieNo) {
  const root = rootDieNo(dieDieNo);
  const docs = await Die.find({ dieDieNo: { $regex: `^${escapeRegExp(root)}(?:$| \\| [A-Z]$)` } })
    .select("_id")
    .lean();
  return docs.map((d) => d._id);
}

// route for systemid form.
router.get("/form/die", async (req, res) => {
  const formatDieNo = (n) => `FS | DIE | ${String(n).padStart(4, "0")}`;
  const parseDieSeq = (dieNo) => {
    const match = String(dieNo || "").match(/^FS \| DIE \| (\d{4})$/);
    return match ? Number(match[1]) : 0;
  };
  const [clients, latestDie, machines, dieVendors] = await Promise.all([
    Client.distinct("clientName"),
    Die.findOne({ dieDieNo: /^FS \| DIE \| \d{4}$/ }).sort({ dieDieNo: -1 }).select("dieDieNo").lean(),
    Machine.find().sort({ machineName: 1 }).lean(),
    Vendor.distinct("vendorName", { commodities: "DIE" }),
  ]);
  dieVendors.sort((a, b) => String(a).localeCompare(String(b)));
  let nextSeq = parseDieSeq(latestDie?.dieDieNo) + 1;
  while (await Die.exists({ dieDieNo: formatDieNo(nextSeq) })) nextSeq++;
  const nextDieNo = formatDieNo(nextSeq);

  // "Create New Version" flow: ?replaces=<dieId> pre-fills the form with the
  // damaged die's specs so only the Die No / Machine No etc. need re-entry.
  let replacesDie = null;
  let versionDieNo = null;
  let nextVersionNumber = null;
  let replaceDieNo = null;
  if (req.query.replaces && mongoose.isValidObjectId(req.query.replaces)) {
    replacesDie = await Die.findById(req.query.replaces).lean();
    if (replacesDie) {
      versionDieNo = replacesDie.dieDieNo;
      nextVersionNumber = (Number(replacesDie.dieVersion) || 1) + 1;
      const replaceRoot = rootDieNo(replacesDie.dieDieNo);
      replaceDieNo = `${replaceRoot} | ${await nextReplaceLetter(replaceRoot)}`;
    }
  }

  res.render("utilities/dieMaster.ejs", {
    CSS: "tabOpt.css",
    title: "Die",
    JS: "clientForm.js",
    clients,
    nextDieNo,
    machines,
    dieVendors,
    replacesDie,
    versionDieNo,
    nextVersionNumber,
    replaceDieNo,
    notification: req.flash("notification"),
  });
});

// Route to handle systemid form submission.
router.post("/form/die", requireAuth, createLimiter, handleDieUpload, async (req, res) => {
  try {
    const files = req.files || {};
    const dieJpgFile = files.dieJpgFile?.[0]?.filename;
    const dieDesignFile = files.dieDesignFile?.[0]?.filename;
    const dieLayoutFile = files.dieLayoutFile?.[0]?.filename;

    if (dieJpgFile) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieJpgFile));
    if (dieDesignFile && /\.(jpg|jpeg)$/i.test(dieDesignFile)) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieDesignFile));
    if (dieLayoutFile && /\.(jpg|jpeg)$/i.test(dieLayoutFile)) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieLayoutFile));

    const { replacesDieId, versionMode, ...body } = req.body;
    let replacesDie = null;
    if (replacesDieId) {
      if (!mongoose.isValidObjectId(replacesDieId)) {
        cleanupDieUploads(req.files);
        return res.status(400).json({ success: false, message: "Invalid die being replaced" });
      }
      replacesDie = await Die.findById(replacesDieId).lean();
      if (!replacesDie) {
        cleanupDieUploads(req.files);
        return res.status(400).json({ success: false, message: "The die being replaced was not found" });
      }
    }

    // Die No / dieVersion are never trusted from the client when replacing —
    // recomputed here (fresh, not the GET-time preview) to stay authoritative
    // and avoid a stale letter if two replacements are created concurrently.
    let dieDieNo = body.dieDieNo;
    let dieVersion = 1;
    const isReplace = replacesDie && versionMode === "replace";
    if (replacesDie) {
      if (isReplace) {
        const root = rootDieNo(replacesDie.dieDieNo);
        dieDieNo = `${root} | ${await nextReplaceLetter(root)}`;
        dieVersion = Number(replacesDie.dieVersion) || 1; // replace leaves version untouched
      } else {
        dieDieNo = replacesDie.dieDieNo; // version: Die No stays identical
        dieVersion = (Number(replacesDie.dieVersion) || 1) + 1;
      }
    }

    const dieSignature = hashSignature(buildDieSignature(body));
    const excludeIds = await lineageDieIds(dieDieNo);
    const duplicateDie = await Die.findOne({ dieSignature, _id: { $nin: excludeIds } })
      .select("dieDieNo")
      .lean();
    if (duplicateDie) {
      cleanupDieUploads(req.files);
      return res.status(400).json({ success: false, message: duplicateMasterMessage("Die", duplicateDie.dieDieNo) });
    }

    const created = await Die.create({
      ...body,
      dieDieNo,
      dieJpgFile,
      dieDesignFile,
      dieLayoutFile,
      replacesDieId: replacesDie ? replacesDie._id : undefined,
      dieVersion,
      dieSignature,
    });

    // The superseded die is taken out of active rotation.
    if (replacesDie) {
      await Die.findByIdAndUpdate(replacesDie._id, { $set: { dieStatus: "INACTIVE" } });
    }

    res.locals.auditDescription = replacesDie
      ? isReplace
        ? `Created die "${created.dieDieNo}" replacing "${replacesDie.dieDieNo}"`
        : `Created die "${created.dieDieNo}" (V${dieVersion}) as a new version of "${replacesDie.dieDieNo}"`
      : `Created die "${created.dieDieNo}" for "${req.body.dieClientName || "N/A"}"`;
    req.flash("notification", "Die created successfully!");
    res.json({ success: true, redirect: "/sachiko/die/view" });
  } catch (err) {
    cleanupDieUploads(req.files);
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/die/view", async (req, res) => {
  const jsonData = await Die.find().sort({ dieDieNo: 1 }).lean();
  res.render("utilities/dieMasterDisp.ejs", {
    CSS: "tableDisp.css",
    JS: false,
    title: "Die Master",
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/die/profile/:id", async (req, res) => {
  const die = await Die.findById(req.params.id).lean();
  if (!die) {
    req.flash("notification", "Die not found");
    return res.redirect("/sachiko/die/view");
  }
  const [replacedDie, replacedByDie] = await Promise.all([
    die.replacesDieId ? Die.findById(die.replacesDieId).select("dieDieNo dieVersion").lean() : null,
    Die.findOne({ replacesDieId: die._id }).select("dieDieNo dieVersion").lean(),
  ]);
  res.render("utilities/dieProfile.ejs", {
    CSS: false,
    JS: false,
    title: "Die Profile",
    die,
    replacedDie,
    replacedByDie,
    notification: req.flash("notification"),
  });
});

// Edit a die (reuses the create form in edit mode).
router.get("/die/edit/:id", async (req, res) => {
  const [die, clients, machines, dieVendors] = await Promise.all([
    Die.findById(req.params.id).lean(),
    Client.distinct("clientName"),
    Machine.find().sort({ machineName: 1 }).lean(),
    Vendor.distinct("vendorName", { commodities: "DIE" }),
  ]);
  if (!die) {
    req.flash("notification", "Die not found");
    return res.redirect("/sachiko/die/view");
  }
  dieVendors.sort((a, b) => String(a).localeCompare(String(b)));
  res.render("utilities/dieMaster.ejs", {
    CSS: "tabOpt.css",
    title: "Edit Die",
    JS: "clientForm.js",
    clients,
    die,
    machines,
    dieVendors,
    notification: req.flash("notification"),
  });
});

router.post("/die/edit/:id", requireAuth, updateLimiter, handleDieUpload, async (req, res) => {
  try {
    const files = req.files || {};
    const dieJpgFile = files.dieJpgFile?.[0]?.filename;
    const dieDesignFile = files.dieDesignFile?.[0]?.filename;
    const dieLayoutFile = files.dieLayoutFile?.[0]?.filename;

    if (dieJpgFile) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieJpgFile));
    if (dieDesignFile && /\.(jpg|jpeg)$/i.test(dieDesignFile)) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieDesignFile));
    if (dieLayoutFile && /\.(jpg|jpeg)$/i.test(dieLayoutFile)) await optimizeDieJpg(path.join(DIE_UPLOAD_DIR, dieLayoutFile));

    const currentDie = await Die.findById(req.params.id)
      .select("dieJpgFile dieDesignFile dieLayoutFile dieVersion dieDieNo")
      .lean();
    if (!currentDie) {
      cleanupDieUploads(req.files);
      return res.status(404).json({ success: false, message: "Die not found" });
    }

    const update = { ...req.body };
    // Version lineage is set once at creation (via the "New Version" flow) and
    // must not be alterable through a plain edit.
    delete update.replacesDieId;
    delete update.dieVersion;
    if (dieJpgFile) update.dieJpgFile = dieJpgFile;
    if (dieDesignFile) update.dieDesignFile = dieDesignFile;
    if (dieLayoutFile) update.dieLayoutFile = dieLayoutFile;

    const dieSignature = hashSignature(buildDieSignature(update));
    const excludeIds = await lineageDieIds(currentDie.dieDieNo);
    const duplicateDie = await Die.findOne({ dieSignature, _id: { $nin: excludeIds } })
      .select("dieDieNo")
      .lean();
    if (duplicateDie) {
      cleanupDieUploads(req.files);
      return res.status(400).json({ success: false, message: duplicateMasterMessage("Die", duplicateDie.dieDieNo) });
    }
    update.dieSignature = dieSignature;

    const updated = await Die.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!updated) {
      cleanupDieUploads(req.files);
      return res.status(404).json({ success: false, message: "Die not found" });
    }

    // Replaced files are no longer referenced by any document — clean them up.
    if (dieJpgFile && currentDie.dieJpgFile) {
      fs.promises.unlink(path.join(DIE_UPLOAD_DIR, currentDie.dieJpgFile)).catch(() => {});
    }
    if (dieDesignFile && currentDie.dieDesignFile) {
      fs.promises.unlink(path.join(DIE_UPLOAD_DIR, currentDie.dieDesignFile)).catch(() => {});
    }
    if (dieLayoutFile && currentDie.dieLayoutFile) {
      fs.promises.unlink(path.join(DIE_UPLOAD_DIR, currentDie.dieLayoutFile)).catch(() => {});
    }

    res.locals.auditDescription = `Updated die "${updated.dieDieNo}"`;
    req.flash("notification", "Die updated successfully!");
    res.json({ success: true, redirect: `/sachiko/die/profile/${req.params.id}` });
  } catch (err) {
    cleanupDieUploads(req.files);
    console.error("DIE EDIT ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET: Serve a die attachment (jpg inline; design inline for image/pdf, download otherwise).
router.get("/die/file/:id/:type", async (req, res) => {
  try {
    const { id, type } = req.params;
    const fieldByType = { jpg: "dieJpgFile", design: "dieDesignFile", layout: "dieLayoutFile" };
    const field = fieldByType[type];
    if (!field || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).send("Invalid request");

    const die = await Die.findById(id).select(`dieDieNo ${field}`).lean();
    const stored = die?.[field];
    if (!die || !stored) return res.status(404).send("File not found");

    const filePath = path.join(DIE_UPLOAD_DIR, path.basename(stored));
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

    const ext = path.extname(stored).replace(".", "").toLowerCase() || "jpg";
    const downloadName = `${String(die.dieDieNo || "die").replace(/[^\w.-]+/g, "_")}_${type}.${ext}`;
    const disposition = ["jpg", "jpeg", "pdf"].includes(ext) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${downloadName}"`);
    res.sendFile(filePath);
  } catch (err) {
    console.error("DIE FILE SERVE ERROR:", err);
    res.status(500).send("Failed to serve file");
  }
});

// ---------------------------------------------------------------------------------------------------->>>>>

// ----------------------------------client display---------------------------------->
// route for client display page.
router.get("/edit/client", async (req, res) => {
  let clients = await Client.find();
  res.render("edit/clientDisp.ejs", {
    CSS: false,
    title: "Client Display",
    JS: false,
    clients,
    notification: req.flash("notification"),
  });
});

// ----------------------------------user display---------------------------------->
// route for user display page.
router.get("/edit/user/:id", async (req, res) => {
  let { id } = req.params;
  let clientData = await Client.findOne({ _id: id }).populate("users");
  let users = clientData.users;
  console.log(users);
  // res.send(users);
  res.render("edit/userDisp.ejs", {
    CSS: false,
    title: "Username Display",
    JS: false,
    users,
    notification: req.flash("notification"),
  });
});


// ----------------------------------Master display---------------------------------->
// route for details page.
router.get("/master/view", async (req, res) => {
  let jsonData = await Username.find()
    .select("clientName clientType accountHead userName userLocation userDepartment locationDetails label labelStock")
    .populate({ path: "label", select: "location" })
    .populate({ path: "labelStock", select: "location" })
    .sort({ clientName: 1, userName: 1 })
    .lean();

  // console.log(jsonData);
  res.render("users/masterDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Client Details",
    notification: req.flash("notification"),
  });
});

// ----------------------------------Vendor display----------------------------------
router.get("/vendor/view", async (req, res) => {
  try {
    const [jsonData, userCounts] = await Promise.all([
      Vendor.find()
        .select("vendorId vendorName vendorStatus hoLocation warehouseLocation commodities vendorGst vendorMsme vendorGumasta vendorPan users")
        .populate({ path: "users", select: "_id" })
        .sort({ vendorName: 1 })
        .lean(),
      VendorUser.aggregate([{ $group: { _id: "$vendorId", count: { $sum: 1 } } }]),
    ]);

    const userCountByVendorId = new Map(
      userCounts.map((entry) => [String(entry._id || ""), Number(entry.count || 0)]),
    );

    jsonData.forEach((vendor) => {
      vendor.userCount = userCountByVendorId.get(String(vendor.vendorId || "")) || 0;
    });

    res.render("users/vendorsView.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Details",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor details");
    res.redirect("/sachiko/form/vendor");
  }
});

router.get("/vendor/profile/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).populate({
      path: "users",
      populate: [
        { path: "label" },
        { path: "tape", populate: { path: "tapeId" } },
      ],
    });

    if (!vendor) {
      req.flash("notification", "Vendor not found");
      return res.redirect("/sachiko/vendor/view");
    }

    res.render("users/vendorProfile.ejs", {
      title: "Vendor Profile",
      vendor,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR PROFILE ERROR:", err);
    req.flash("notification", "Invalid vendor link");
    res.redirect("/sachiko/vendor/view");
  }
});

// Backward-compatible redirect for the old vendor coordinator URL.
router.get("/vendor/user/view", async (req, res) => {
  return res.redirect("/sachiko/vendor/coordinator/view");
});

// ----------------------------------Vendor coordinator display----------------------------------
router.get("/vendor/coordinator/view", async (req, res) => {
  try {
    const jsonData = await VendorUser.aggregate([
      {
        $lookup: {
          from: "vendors",
          localField: "vendorId",
          foreignField: "vendorId",
          as: "vendorInfo",
        },
      },
      {
        $addFields: {
          commodities: { $ifNull: [{ $arrayElemAt: ["$vendorInfo.commodities", 0] }, []] },
        },
      },
      {
        $project: {
          vendorInfo: 0, // Remove the lookup array
        },
      },
      { $sort: { vendorName: 1, userName: 1 } },
    ]);

    jsonData.forEach((row) => {
      row.dispatchType = row.SelfDispatch ? "Self Dispatch" : "Transport";
      row.tapeCount = row.tape?.length || 0;
    });

    res.render("users/vendorUserView.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Coordinator View",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator view");
    res.redirect("/sachiko/form/vendor");
  }
});

// ----------------------------------Vendor coordinator details----------------------------------
router.get("/vendor/coordinator/details/:userId", async (req, res) => {
  try {
    const vendorUser = await VendorUser.findById(req.params.userId)
      .populate("label")
      .populate({
        path: "tape",
        populate: { path: "tapeId" },
      })
      .lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/sachiko/vendor/coordinator/view");
    }

    const vendor = await Vendor.findOne({ vendorId: vendorUser.vendorId }).lean();

    const stats = {
      labels: (vendorUser.label || []).length,
      tapes: (vendorUser.tape || []).length,
    };

    res.render("users/vendorUserDetails.ejs", {
      title: "Vendor Coordinator Details",
      CSS: false,
      JS: false,
      vendorUser,
      vendor,
      labels: vendorUser.label || [],
      tapes: vendorUser.tape || [],
      stats,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR DETAILS ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator details");
    res.redirect("/sachiko/vendor/coordinator/view");
  }
});

router.post("/vendor/coordinator/details/:userId/delete", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const vendorUser = await VendorUser.findById(userId).lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/sachiko/vendor/coordinator/view");
    }

    await Vendor.updateOne(
      { vendorId: vendorUser.vendorId },
      { $pull: { users: vendorUser._id } },
    );

    await VendorUser.deleteOne({ _id: vendorUser._id });

    res.locals.auditDescription = `Deleted vendor coordinator "${vendorUser.userName}"`;
    req.flash("notification", `Coordinator ${vendorUser.userName} removed successfully`);
    return res.redirect("/sachiko/vendor/coordinator/view");
  } catch (err) {
    console.error("VENDOR COORDINATOR DELETE ERROR:", err);
    req.flash("notification", "Failed to remove coordinator");
    return res.redirect("/sachiko/vendor/coordinator/details/" + req.params.userId);
  }
});

// ----------------------------------Vendor coordinator edit----------------------------------
router.get("/form/edit/vendor-user/:userId", async (req, res) => {
  try {
    const user = await VendorUser.findById(req.params.userId).lean();
    if (!user) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/sachiko/vendor/coordinator/view");
    }

    const vendor = await Vendor.findOne({ vendorId: user.vendorId }).lean();

    // Build the rows for the form. Pick up details are now per-location; for
    // legacy coordinators whose stored locationDetails predate that, backfill the
    // primary (first) location's pick up details from the top-level fields so
    // editing doesn't wipe the existing pick up info.
    const stored = Array.isArray(user.locationDetails) && user.locationDetails.length
      ? user.locationDetails
      : [{ userLocation: user.userLocation || "", dispatchAddress: user.dispatchAddress || "" }];

    const hasPrimaryDispatch = stored[0] && (
      stored[0].selfDispatch || stored[0].transportName || stored[0].transportContact ||
      stored[0].dropLocation || stored[0].dropLocation1 || stored[0].deliveryMode ||
      stored[0].deliveryLocation || stored[0].deliveryLocation1 || stored[0].vendorPayment
    );
    if (stored[0] && !hasPrimaryDispatch) {
      stored[0] = {
        ...stored[0],
        selfDispatch: user.SelfDispatch || "",
        transportName: user.transportName || "",
        transportContact: user.transportContact || "",
        dropLocation: user.dropLocation || "",
        dropLocation1: user.dropLocation1 || "",
        deliveryMode: user.deliveryMode || "",
        deliveryLocation: user.deliveryLocation || "",
        deliveryLocation1: user.deliveryLocation1 || "",
        vendorPayment: user.vendorPayment || "",
      };
    }

    res.render("users/editVendorUser.ejs", {
      title: "Edit Vendor Coordinator",
      CSS: "tabOpt.css",
      JS: false,
      user,
      vendor,
      initialLocationDetails: stored,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator edit page");
    res.redirect("/sachiko/vendor/coordinator/view");
  }
});

router.post("/form/edit/vendor-user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await VendorUser.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Vendor coordinator not found" });
    }

    const vendorId = String(user.vendorId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );
    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }
    const primaryLocation = locationDetails[0];

    const vendor = await Vendor.findOne({ vendorId: user.vendorId }).lean();
    const vendorSnapshot = getVendorSnapshot(vendor, user);

    const updatedData = {
      ...vendorSnapshot,
      vendorId,
      vendorName: vendorSnapshot.vendorName,
      vendorStatus: vendorSnapshot.vendorStatus,
      hoLocation: vendorSnapshot.hoLocation,
      warehouseLocation: vendorSnapshot.warehouseLocation,
      userName,
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (vendor coordinator view/details) keep working.
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      dropLocation1: primaryLocation.dropLocation1 || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      deliveryLocation1: primaryLocation.deliveryLocation1 || "",
      vendorPayment: primaryLocation.vendorPayment || "",
      SelfDispatch: primaryLocation.selfDispatch || "",
      vendorStatus: vendorSnapshot.vendorStatus,
      ownerName: String(req.body.ownerName || "").trim(),
      ownerMobNo: String(req.body.ownerMobNo || "").trim(),
      ownerEmail: String(req.body.ownerEmail || "").trim(),
      vendorGst: vendorSnapshot.vendorGst,
      vendorMsme: vendorSnapshot.vendorMsme,
    };

    updatedData.vendorUserSignature = hashSignature(buildVendorUserSignature(updatedData, vendorId));

    const duplicateVendorUser = await VendorUser.findOne({
      _id: { $ne: userId },
      $or: [
        { vendorUserSignature: updatedData.vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    await VendorUser.findByIdAndUpdate(userId, updatedData, { runValidators: true });
    res.locals.auditDescription = `Updated vendor coordinator "${userName}"`;
    req.flash("notification", "Vendor coordinator updated successfully!");
    return res.json({ success: true, redirect: `/sachiko/vendor/coordinator/details/${userId}` });
  } catch (err) {
    console.error("VENDOR COORDINATOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels display (individual)---------------------------------->
// route for details page.
router.get("/disp/labels", async (req, res) => {
  let jsonData = await Label.find();

  res.render("inventory/labels/labelsDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Labels Display",
    notification: req.flash("notification"),
  });
});

// Display all Labels bound to a client user (rich view with actions).
router.get("/labels/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id).populate("label").lean();
    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("back");
    }

    // When arriving from the per-location count on the master view, only show
    // bindings for that location; without the param, show all of the user's.
    const locationFilter = typeof req.query.location === "string" ? req.query.location.trim() : "";
    const sameLoc = (a, b) => normalizeLocationName(a) === normalizeLocationName(b);

    let labels = user.label || [];
    if (locationFilter) {
      labels = labels.filter((binding) => sameLoc(binding.location, locationFilter));
    }

    const jsonData = labels.map((binding) => ({
      ...binding,
      // Show the live user's identity, not the binding's own (possibly stale) snapshot.
      clientName: user.clientName,
      userName: user.userName,
      userContact: user.userContact,
      status: binding.status || "ACTIVE",
      userId: req.params.id,
    }));

    res.render("inventory/labels/labelsBindingDisp.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Labels Display",
      clientName: user.clientName || "",
      userName: user.userName || "",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("LABELS VIEW ERROR:", err);
    res.redirect("back");
  }
});



// Remove a Label binding.
router.post("/labels-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const [owner, binding] = await Promise.all([
      Username.findOne({ label: req.params.id }).select("_id").lean(),
      Label.findById(req.params.id).select("productId").lean(),
    ]);
    await Label.deleteOne({ _id: req.params.id });
    if (owner) {
      await Username.updateOne({ _id: owner._id }, { $pull: { label: req.params.id } });
    }

    res.locals.auditDescription = `Deleted label binding "${binding?.productId || req.params.id}"`;
    req.flash("notification", "Label binding removed successfully!");
    return res.redirect(owner ? `/sachiko/labels/view/${owner._id}` : "/sachiko/master/view");
  } catch (err) {
    console.error("LABEL BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Label binding");
    return res.redirect("back");
  }
});

// Set a label binding INACTIVE.
router.post("/labels-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await Label.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set label binding "${binding.productId}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// Set a label binding ACTIVE.
router.post("/labels-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await Label.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set label binding "${binding.productId}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ----------------------------------Welcome---------------------------------->
const MOTIVATIONAL_QUOTES = [
  { q: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
  { q: "Success is not final; failure is not fatal: it is the courage to continue that counts.", a: "Winston Churchill" },
  { q: "Believe you can and you're halfway there.", a: "Theodore Roosevelt" },
  { q: "The best way to predict the future is to create it.", a: "Peter Drucker" },
  { q: "Everything you’ve ever wanted is on the other side of fear.", a: "George Addair" },
  { q: "The only limit to our realization of tomorrow will be our doubts of today.", a: "Franklin D. Roosevelt" },
  { q: "Hardships often prepare ordinary people for an extraordinary destiny.", a: "C.S. Lewis" },
  { q: "Your time is limited, so don't waste it living someone else's life.", a: "Steve Jobs" },
  { q: "Success is walking from failure to failure with no loss of enthusiasm.", a: "Winston Churchill" },
  { q: "Whether you think you can or you think you can't, you're right.", a: "Henry Ford" },
  { q: "The future belongs to those who believe in the beauty of their dreams.", a: "Eleanor Roosevelt" },
  { q: "Don't watch the clock; do what it does. Keep going.", a: "Sam Levenson" },
  { q: "The search for excellence is a journey, not a destination.", a: "Unknown" },
  { q: "What you get by achieving your goals is not as important as what you become by achieving your goals.", a: "Zig Ziglar" },
  { q: "It always seems impossible until it's done.", a: "Nelson Mandela" },
  { q: "Quality is not an act, it is a habit.", a: "Aristotle" },
  { q: "The only person you are destined to become is the person you decide to be.", a: "Ralph Waldo Emerson" },
  { q: "Be so good they can't ignore you.", a: "Steve Martin" },
  { q: "Integrity is doing the right thing, even when no one is watching.", a: "C.S. Lewis" },
  { q: "The secret of getting ahead is getting started.", a: "Mark Twain" }
];

router.get("/api/motivational", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
  res.json(quote);
});

router.get("/welcome", (req, res) => {
  res.render("miscellaneous/welcome.ejs", {
    title: "Welcome",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

export default router;
