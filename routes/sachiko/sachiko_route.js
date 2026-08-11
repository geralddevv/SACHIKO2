import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import Vendor from "../../models/users/vendor.js";
import Counter from "../../models/system/counter.js";
import FacestockMaster from "../../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import SachikoJobcard from "../../models/sachiko/sachikoJobcard.js";
import SachikoSalesOrder from "../../models/sachiko/sachikoSalesOrder.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* ================= FILE UPLOAD (LABEL STOCK WORD FILE) ================= */
const LABEL_STOCK_UPLOAD_DIR = path.resolve("uploads/sachiko/labelstocks");
fs.mkdirSync(LABEL_STOCK_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LABEL_STOCK_UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, randomBytes(16).toString("hex") + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowedExts = [".doc", ".docx"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return cb(new Error("Only Word files (.doc, .docx) are allowed"), false);
  }
  cb(null, true);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

const handleWordUpload = (req, res, next) => {
  upload.single("wordFile")(req, res, (err) => {
    if (err) {
      req.flash("notification", err.message);
      return res.redirect("back");
    }
    next();
  });
};

// Same upload handling as handleWordUpload, but for the label-stock create
// dialog, which submits via fetch and needs a JSON error response instead of
// a redirect.
const handleWordUploadJson = (req, res, next) => {
  upload.single("wordFile")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

/* ================= HELPERS ================= */
// Generate a sequential id of the form `SP | <CODE> | 000001`.
async function generateId(key, code) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | ${code} | ${String(counter.seq).padStart(6, "0")}`;
}

// Preview the next id without consuming a sequence number.
async function previewId(key, code) {
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const nextSeq = Number(counter?.seq || 0) + 1;
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const trim = (value) => String(value ?? "").trim();

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// SKU code format mirrors the Tape master's Product ID (routes/fairdesk_route.js
// formatTapeId): `FS | LS | 000001`. Scanned/incremented directly against the
// highest existing skuCode, same as Tape, rather than the shared Counter used
// by labelStockId/jobCardId/lotNo above -- this is a separate, human-facing
// SKU, not the row's own generated identifier.
const formatSkuCode = (n) => `FS | LS | ${String(n).padStart(6, "0")}`;
const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

async function previewNextSkuCode() {
  const latest = await SachikoLabelStock.findOne().sort({ skuCode: -1 }).select("skuCode").lean();
  let nextSeq = parseSkuSeq(latest?.skuCode) + 1;
  while (await SachikoLabelStock.exists({ skuCode: formatSkuCode(nextSeq) })) {
    nextSeq += 1;
  }
  return formatSkuCode(nextSeq);
}

async function generateSkuCode() {
  let nextSeq = parseSkuSeq(
    (await SachikoLabelStock.findOne().sort({ skuCode: -1 }).select("skuCode").lean())?.skuCode,
  ) + 1;

  const maxAttempts = 10000;
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = formatSkuCode(nextSeq);
    if (!(await SachikoLabelStock.exists({ skuCode: candidate }))) return candidate;
    nextSeq += 1;
  }
  throw new Error("Unable to generate unique Label Stock SKU code");
}

/* ================= LABEL STOCK ================= */
router.get("/label-stock/view", async (req, res) => {
  const [jsonData, previewSkuCode, facestockMasters, adhesiveMasters, releaseMasters] = await Promise.all([
    SachikoLabelStock.find().sort({ skuCode: 1 }).lean(),
    previewNextSkuCode(),
    FacestockMaster.find().select("skuId family type make vendorId vendorName vendorSkuCode gsm micron").lean(),
    AdhesiveMaster.find().select("skuId type make vendorId vendorName vendorSkuCode shelfLife").lean(),
    ReleaseMaster.find().select("skuId type make vendorId vendorName color gsm").lean(),
  ]);
  res.render("sachiko/labelStockView.ejs", {
    title: "Label Stock View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    previewSkuCode,
    facestockMasters,
    adhesiveMasters,
    releaseMasters,
    notification: req.flash("notification"),
  });
});

router.get("/label-stock/form", async (req, res) => {
  const previewSkuCode = await previewNextSkuCode();
  res.render("sachiko/labelStockForm.ejs", {
    title: "Label Stock Form",
    CSS: false,
    JS: false,
    previewSkuCode,
    notification: req.flash("notification"),
  });
});

// vendorId is posted from the Facestock/Facestock (Layer 2) "Vendor Name"
// select (Vendor master, filtered to commodities: "FACE PAPER"); vendorName
// is denormalized onto the layer the same way Paper/Facestock Master pair
// vendorId + vendorName (see CLAUDE.md).
async function resolveVendorName(vendorId) {
  if (!vendorId) return "";
  const vendor = await Vendor.findById(vendorId).select("vendorName").lean();
  return vendor?.vendorName || "";
}

// DOUBLE FACESTOCK carries a second facestock+adhesive pair (one release
// liner); DOUBLE RELEASE carries a second adhesive+release-liner pair (one
// facestock) -- see the field comments on the SachikoLabelStock schema.
async function buildLabelStockPayload(body) {
  const rollType = trim(body.rollType) || "NORMAL";
  const rollOrSheet = trim(body.rollOrSheet);
  const printingTechnology = trim(body.printingTechnology);
  const facestockVendorId = trim(body.facestockVendorId);
  const adhesiveVendorId = trim(body.adhesiveVendorId);
  const releaseLinerVendorId = trim(body.releaseLinerVendorId);
  const payload = {
    productCode: trim(body.productCode),
    rollType,
    family: trim(body.family),
    rollOrSheet,
    printingTechnology,
    facestock: {
      facestockFamily: trim(body.facestockFamily),
      facestockType: trim(body.facestockType),
      facestockMake: trim(body.facestockMake),
      facestockVendorId: facestockVendorId || undefined,
      facestockVendorName: await resolveVendorName(facestockVendorId),
      facestockVendorSkuCode: trim(body.facestockVendorSkuCode),
      facestockGsm: numOrUndef(body.facestockGsm),
      facestockMicron: numOrUndef(body.facestockMicron),
    },
    adhesive: {
      adhesiveType: trim(body.adhesiveType),
      adhesiveMake: trim(body.adhesiveMake),
      adhesiveVendorId: adhesiveVendorId || undefined,
      adhesiveVendorName: await resolveVendorName(adhesiveVendorId),
      adhesiveVendorSkuCode: trim(body.adhesiveVendorSkuCode),
      adhesiveShelfLife: trim(body.adhesiveShelfLife),
      adhesiveGsm: numOrUndef(body.adhesiveGsm),
    },
    releaseLiner: {
      releaseLinerType: trim(body.releaseLinerType),
      releaseLinerMake: trim(body.releaseLinerMake),
      releaseLinerVendorId: releaseLinerVendorId || undefined,
      releaseLinerVendorName: await resolveVendorName(releaseLinerVendorId),
      releaseLinerColor: trim(body.releaseLinerColor) || "WHITE",
      releaseLinerGsm: numOrUndef(body.releaseLinerGsm),
    },
  };

  if (rollOrSheet === "SHEET" && printingTechnology === "DIGITAL") {
    payload.digitalPrintType = trim(body.digitalPrintType);
  }

  if (rollType === "DOUBLE FACESTOCK") {
    const facestockVendorId2 = trim(body.facestockVendorId2);
    const adhesiveVendorId2 = trim(body.adhesiveVendorId2);
    payload.facestock2 = {
      facestockFamily: trim(body.facestockFamily2),
      facestockType: trim(body.facestockType2),
      facestockMake: trim(body.facestockMake2),
      facestockVendorId: facestockVendorId2 || undefined,
      facestockVendorName: await resolveVendorName(facestockVendorId2),
      facestockVendorSkuCode: trim(body.facestockVendorSkuCode2),
      facestockGsm: numOrUndef(body.facestockGsm2),
      facestockMicron: numOrUndef(body.facestockMicron2),
    };
    payload.adhesive2 = {
      adhesiveType: trim(body.adhesiveType2),
      adhesiveMake: trim(body.adhesiveMake2),
      adhesiveVendorId: adhesiveVendorId2 || undefined,
      adhesiveVendorName: await resolveVendorName(adhesiveVendorId2),
      adhesiveVendorSkuCode: trim(body.adhesiveVendorSkuCode2),
      adhesiveShelfLife: trim(body.adhesiveShelfLife2),
      adhesiveGsm: numOrUndef(body.adhesiveGsm2),
    };
  } else if (rollType === "DOUBLE RELEASE") {
    const adhesiveVendorId2 = trim(body.adhesiveVendorId2);
    const releaseLinerVendorId2 = trim(body.releaseLinerVendorId2);
    payload.adhesive2 = {
      adhesiveType: trim(body.adhesiveType2),
      adhesiveMake: trim(body.adhesiveMake2),
      adhesiveVendorId: adhesiveVendorId2 || undefined,
      adhesiveVendorName: await resolveVendorName(adhesiveVendorId2),
      adhesiveVendorSkuCode: trim(body.adhesiveVendorSkuCode2),
      adhesiveShelfLife: trim(body.adhesiveShelfLife2),
      adhesiveGsm: numOrUndef(body.adhesiveGsm2),
    };
    payload.releaseLiner2 = {
      releaseLinerType: trim(body.releaseLinerType2),
      releaseLinerMake: trim(body.releaseLinerMake2),
      releaseLinerVendorId: releaseLinerVendorId2 || undefined,
      releaseLinerVendorName: await resolveVendorName(releaseLinerVendorId2),
      releaseLinerColor: trim(body.releaseLinerColor2) || "WHITE",
      releaseLinerGsm: numOrUndef(body.releaseLinerGsm2),
    };
  }

  return payload;
}

router.post("/label-stock/form", requireAuth, createLimiter, handleWordUploadJson, async (req, res) => {
  try {
    const labelStockId = await generateId("sachikoLabelStockId", "LS");
    const skuCode = await generateSkuCode();
    const payload = await buildLabelStockPayload(req.body);
    if (!payload.productCode) {
      throw Object.assign(new Error("Product Code is required"), { userMessage: "Product Code is required" });
    }
    if (!payload.family) {
      throw Object.assign(new Error("Family is required"), { userMessage: "Family is required" });
    }
    if (!payload.rollOrSheet) {
      throw Object.assign(new Error("Roll or Sheet is required"), { userMessage: "Roll or Sheet is required" });
    }
    if (!payload.printingTechnology) {
      throw Object.assign(new Error("Printing Technology is required"), { userMessage: "Printing Technology is required" });
    }
    if (payload.rollOrSheet === "SHEET" && payload.printingTechnology === "DIGITAL" && !payload.digitalPrintType) {
      throw Object.assign(new Error("Laser or Ink is required"), { userMessage: "Laser or Ink is required" });
    }
    if (req.file) {
      payload.wordFile = req.file.filename;
      payload.wordFileOriginalName = req.file.originalname;
    }
    await SachikoLabelStock.create({ labelStockId, skuCode, ...payload });
    req.flash("notification", "Label Stock created successfully!");
    res.json({ success: true, redirect: "/sachiko/label-stock/view" });
  } catch (err) {
    console.error("SACHIKO LABEL STOCK CREATE ERROR:", err);
    if (req.file) fs.existsSync(path.join(LABEL_STOCK_UPLOAD_DIR, req.file.filename)) && fs.unlinkSync(path.join(LABEL_STOCK_UPLOAD_DIR, req.file.filename));
    res.status(400).json({ success: false, message: err.userMessage || "Failed to create Label Stock" });
  }
});

router.get("/label-stock/edit/:id", async (req, res) => {
  const [ds, facestockMasters, adhesiveMasters, releaseMasters] = await Promise.all([
    SachikoLabelStock.findById(req.params.id).lean(),
    FacestockMaster.find().select("skuId family type make vendorId vendorName vendorSkuCode gsm micron").lean(),
    AdhesiveMaster.find().select("skuId type make vendorId vendorName vendorSkuCode shelfLife").lean(),
    ReleaseMaster.find().select("skuId type make vendorId vendorName color gsm").lean(),
  ]);
  if (!ds) {
    req.flash("notification", "Label Stock not found");
    return res.redirect("/sachiko/label-stock/view");
  }
  res.render("sachiko/labelStockEdit.ejs", {
    title: "Edit Label Stock",
    CSS: false,
    JS: false,
    ds,
    facestockMasters,
    adhesiveMasters,
    releaseMasters,
    notification: req.flash("notification"),
  });
});

router.post("/label-stock/edit/:id", requireAuth, updateLimiter, handleWordUpload, async (req, res) => {
  try {
    const existing = await SachikoLabelStock.findById(req.params.id);
    if (!existing) {
      req.flash("notification", "Label Stock not found");
      return res.redirect("/sachiko/label-stock/view");
    }

    const payload = await buildLabelStockPayload(req.body);

    if (req.file) {
      // Remove the previous file before swapping in the new one.
      if (existing.wordFile) {
        const oldPath = path.join(LABEL_STOCK_UPLOAD_DIR, existing.wordFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      payload.wordFile = req.file.filename;
      payload.wordFileOriginalName = req.file.originalname;
    }

    // Clear whichever second-layer fields the new rollType no longer calls
    // for, so switching a roll back to NORMAL (or between the two double
    // modes) doesn't leave a stale facestock2/adhesive2/releaseLiner2 behind.
    const unset = {};
    for (const key of ["facestock2", "adhesive2", "releaseLiner2", "digitalPrintType"]) {
      if (!(key in payload)) unset[key] = "";
    }

    const update = Object.keys(unset).length ? { $set: payload, $unset: unset } : payload;
    await SachikoLabelStock.findByIdAndUpdate(req.params.id, update);
    req.flash("notification", "Label Stock updated successfully!");
    res.redirect("/sachiko/label-stock/view");
  } catch (err) {
    console.error("SACHIKO LABEL STOCK UPDATE ERROR:", err);
    req.flash("notification", "Failed to update Label Stock");
    res.redirect(`/sachiko/label-stock/edit/${req.params.id}`);
  }
});

router.get("/label-stock/file/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(LABEL_STOCK_UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  const ds = await SachikoLabelStock.findOne({ wordFile: filename }).select("wordFileOriginalName").lean();
  res.download(filePath, ds?.wordFileOriginalName || filename);
});

router.delete("/label-stock/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ds = await SachikoLabelStock.findByIdAndDelete(req.params.id);
    if (!ds) {
      return res.status(404).json({ success: false, message: "Label Stock not found" });
    }
    if (ds.wordFile) {
      const filePath = path.join(LABEL_STOCK_UPLOAD_DIR, ds.wordFile);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("SACHIKO LABEL STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete Label Stock" });
  }
});

/* ================= JOB CARD ================= */
router.get("/jobcard/view", async (req, res) => {
  const jsonData = await SachikoJobcard.find().sort({ createdAt: -1 }).lean();
  res.render("sachiko/jobcardView.ejs", {
    title: "Job Card View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/jobcard/form", async (req, res) => {
  const labelStocks = await SachikoLabelStock.find().sort({ productCode: 1 }).lean();
  const previewLotNo = await previewId("sachikoLotNo", "LOT");
  res.render("sachiko/jobcardForm.ejs", {
    title: "Job Card Form",
    CSS: false,
    JS: false,
    labelStocks,
    previewLotNo,
    notification: req.flash("notification"),
  });
});

router.post("/jobcard/form", requireAuth, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    const jobCardId = await generateId("sachikoJobCardId", "JC");
    const lotNo = await generateId("sachikoLotNo", "LOT");

    // Job Setting rows
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => ({
        mtrs1: numOrUndef(jsMtrs1[i]),
        startTime: trim(jsStart[i]),
        mtrs2: numOrUndef(jsMtrs2[i]),
        stopTime: trim(jsStop[i]),
      }))
      .filter((row) => row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows
    const deckleId = toArray(b.deckleId);
    const logMeters = toArray(b.logMeters);
    const faceJoint = toArray(b.faceJoint);
    const faceMtr = toArray(b.faceMtr);
    const releaseJoint = toArray(b.releaseJoint);
    const releaseMtr = toArray(b.releaseMtr);
    const startTime = toArray(b.startTime);
    const endTime = toArray(b.endTime);
    const productionLog = deckleId
      .map((_, i) => ({
        deckleId: trim(deckleId[i]),
        meters: numOrUndef(logMeters[i]),
        face: { joint: trim(faceJoint[i]), mtr: numOrUndef(faceMtr[i]) },
        release: { joint: trim(releaseJoint[i]), mtr: numOrUndef(releaseMtr[i]) },
        time: { startTime: trim(startTime[i]), endTime: trim(endTime[i]) },
      }))
      .filter((row) => row.deckleId || row.meters != null || row.face.mtr != null || row.release.mtr != null);

    await SachikoJobcard.create({
      jobCardId,
      date: b.date ? new Date(b.date) : new Date(),
      productCode: trim(b.productCode),
      quantity: numOrUndef(b.quantity),
      lotNo,
      machineNo: trim(b.machineNo),
      operatorName: trim(b.operatorName),
      helperName: trim(b.helperName),
      faceStock: {
        rollDrumNo: trim(b.fsRollDrumNo),
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
      },
      adhesive: {
        rollDrumNo: trim(b.adRollDrumNo),
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
      },
      releaseLiner: {
        rollDrumNo: trim(b.rlRollDrumNo),
        code: trim(b.rlCode),
        gsmMic: trim(b.rlGsmMic),
        size: trim(b.rlSize),
      },
      jobSetting,
      productionLog,
      totalMeter: trim(b.totalMeter),
      sqMtr: trim(b.sqMtr),
    });

    req.flash("notification", "Job card created successfully!");
    res.redirect("/sachiko/jobcard/view");
  } catch (err) {
    console.error("SACHIKO JOBCARD CREATE ERROR:", err);
    req.flash("notification", "Failed to create job card");
    res.redirect("/sachiko/jobcard/form");
  }
});

/* ================= SALES ORDER ================= */
router.get("/sales/order", async (req, res) => {
  const [clients, clientUsers, labelStocks] = await Promise.all([
    Client.find().select("clientId clientName").sort({ clientName: 1 }).lean(),
    Username.find().select("clientId userName").lean(),
    SachikoLabelStock.find().sort({ productCode: 1 }).lean(),
  ]);
  const previewSalesOrderId = await previewId("sachikoSalesOrderId", "SO");
  res.render("sachiko/salesOrderForm.ejs", {
    title: "Sales Order",
    CSS: false,
    JS: false,
    clients,
    clientUsers,
    labelStocks,
    previewSalesOrderId,
    notification: req.flash("notification"),
  });
});

router.post("/sales/order", requireAuth, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    const salesOrderId = await generateId("sachikoSalesOrderId", "SO");

    await SachikoSalesOrder.create({
      salesOrderId,
      date: b.date ? new Date(b.date) : new Date(),
      clientName: trim(b.clientName),
      clientUserName: trim(b.clientUserName),
      productCode: trim(b.productCode),
      deckleType: trim(b.deckleType),
      faceStock: {
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
        rollDrumNo: trim(b.fsRollDrumNo),
      },
      adhesive: {
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
        rollDrumNo: trim(b.adRollDrumNo),
      },
      releaseLiner: {
        code: trim(b.rlCode),
        gsmMic: trim(b.rlGsmMic),
        size: trim(b.rlSize),
        rollDrumNo: trim(b.rlRollDrumNo),
      },
    });

    req.flash("notification", "Sales order created successfully!");
    res.redirect("/sachiko/sales/order");
  } catch (err) {
    console.error("SACHIKO SALES ORDER CREATE ERROR:", err);
    req.flash("notification", "Failed to create sales order");
    res.redirect("/sachiko/sales/order");
  }
});

export default router;
