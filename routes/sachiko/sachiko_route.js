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
import Family from "../../models/system/family.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import SachikoJobcard from "../../models/sachiko/sachikoJobcard.js";
import SachikoSalesOrder from "../../models/sachiko/sachikoSalesOrder.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { buildLabelStockSignature, buildMaterialSignature, generateFamilyProductCode, findLabelStockSpecMatch, resolveLabelStockSkuCode } from "../../utils/labelStockVariant.js";

const router = express.Router();

/* ================= FILE UPLOAD (LABEL STOCK WORD/PDF FILES) ================= */
const LABEL_STOCK_UPLOAD_DIR = path.resolve("uploads/sachiko/labelstocks");
fs.mkdirSync(LABEL_STOCK_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LABEL_STOCK_UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, randomBytes(16).toString("hex") + path.extname(file.originalname));
  },
});

// Two independent attachment slots -- wordFile only takes .doc/.docx,
// pdfFile only .pdf, each checked by its own field name.
const LABEL_STOCK_FIELD_EXTS = {
  wordFile: { exts: [".doc", ".docx"], label: "Word (.doc, .docx)" },
  pdfFile: { exts: [".pdf"], label: "PDF (.pdf)" },
};

const fileFilter = (req, file, cb) => {
  const rule = LABEL_STOCK_FIELD_EXTS[file.fieldname];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!rule || !rule.exts.includes(ext)) {
    return cb(new Error(`Only ${rule?.label || "the expected file type"} is allowed for this field`), false);
  }
  cb(null, true);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadLabelStockFiles = upload.fields([
  { name: "wordFile", maxCount: 1 },
  { name: "pdfFile", maxCount: 1 },
]);

// Label Stock create/edit both happen in the same dialog (labelStockView.ejs)
// and submit via fetch, so both need a JSON error response instead of a
// redirect.
const handleWordUploadJson = (req, res, next) => {
  uploadLabelStockFiles(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// req.files is { wordFile: [file], pdfFile: [file] } (only the fields that
// were actually posted) -- used both to pick the just-uploaded file for each
// slot and to clean up on a failed save.
const labelStockFile = (req, field) => req.files?.[field]?.[0];
const allLabelStockFiles = (req) => Object.values(req.files || {}).flat();

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

// Release Liner Sensing -- the same two values Release Master offers (see
// SENSING_OPTIONS in routes/system/releaseMaster.js). Anything else posted
// (including the cascade's "-- None --" sentinel, which the dialog already
// normalizes away, and the blank every recipe carries until its master has
// Sensing filled in) is stored as "not stated".
const SENSING_OPTIONS = ["SENSING", "NON-SENSING"];
const sensingOrBlank = (value) => {
  const v = trim(value).toUpperCase();
  return SENSING_OPTIONS.includes(v) ? v : "";
};

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// SKU code format mirrors the Tape master's Product ID (routes/fairdesk_route.js
// formatTapeId): `SP | LS | 000001`. Scanned/incremented directly against the
// highest existing skuCode, same as Tape, rather than the shared Counter used
// by labelStockId/jobCardId/lotNo above -- this is a separate, human-facing
// SKU, not the row's own generated identifier.
const formatSkuCode = (n) => `SP | LS | ${String(n).padStart(6, "0")}`;
const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})(?:-[A-Z]+)?$/);
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

/* ================= LABEL STOCK ================= */
router.get("/label-stock/view", async (req, res) => {
  const [jsonData, previewSkuCode, facestockMasters, adhesiveMasters, releaseMasters, families] = await Promise.all([
    SachikoLabelStock.find().sort({ skuCode: 1 }).lean(),
    previewNextSkuCode(),
    FacestockMaster.find().select("skuId family type make vendorId vendorName vendorSkuCode size gsm micron").lean(),
    AdhesiveMaster.find().select("skuId type make vendorId vendorName vendorSkuCode viscosity cohesion shear density").lean(),
    ReleaseMaster.find().select("skuId type make sensing vendorId vendorName vendorSkuCode color size gsm").lean(),
    Family.find().sort({ familyName: 1 }).lean(),
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
    families,
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
      facestockSize: trim(body.facestockSize),
      facestockGsm: numOrUndef(body.facestockGsm),
      facestockMicron: numOrUndef(body.facestockMicron),
    },
    adhesive: {
      adhesiveType: trim(body.adhesiveType),
      adhesiveMake: trim(body.adhesiveMake),
      adhesiveVendorId: adhesiveVendorId || undefined,
      adhesiveVendorName: await resolveVendorName(adhesiveVendorId),
      adhesiveVendorSkuCode: trim(body.adhesiveVendorSkuCode),
      adhesiveViscosity: numOrUndef(body.adhesiveViscosity),
      adhesiveCohesion: numOrUndef(body.adhesiveCohesion),
      adhesiveShear: numOrUndef(body.adhesiveShear),
      adhesiveDensity: numOrUndef(body.adhesiveDensity),
      adhesiveGsm: numOrUndef(body.adhesiveGsm),
    },
    releaseLiner: {
      releaseLinerType: trim(body.releaseLinerType),
      releaseLinerMake: trim(body.releaseLinerMake),
      releaseLinerSensing: sensingOrBlank(body.releaseLinerSensing),
      releaseLinerVendorId: releaseLinerVendorId || undefined,
      releaseLinerVendorName: await resolveVendorName(releaseLinerVendorId),
      releaseLinerVendorSkuCode: trim(body.releaseLinerVendorSkuCode),
      releaseLinerColor: trim(body.releaseLinerColor) || "WHITE",
      releaseLinerSize: trim(body.releaseLinerSize),
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
      facestockSize: trim(body.facestockSize2),
      facestockGsm: numOrUndef(body.facestockGsm2),
      facestockMicron: numOrUndef(body.facestockMicron2),
    };
    payload.adhesive2 = {
      adhesiveType: trim(body.adhesiveType2),
      adhesiveMake: trim(body.adhesiveMake2),
      adhesiveVendorId: adhesiveVendorId2 || undefined,
      adhesiveVendorName: await resolveVendorName(adhesiveVendorId2),
      adhesiveVendorSkuCode: trim(body.adhesiveVendorSkuCode2),
      adhesiveViscosity: numOrUndef(body.adhesiveViscosity2),
      adhesiveCohesion: numOrUndef(body.adhesiveCohesion2),
      adhesiveShear: numOrUndef(body.adhesiveShear2),
      adhesiveDensity: numOrUndef(body.adhesiveDensity2),
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
      adhesiveViscosity: numOrUndef(body.adhesiveViscosity2),
      adhesiveCohesion: numOrUndef(body.adhesiveCohesion2),
      adhesiveShear: numOrUndef(body.adhesiveShear2),
      adhesiveDensity: numOrUndef(body.adhesiveDensity2),
      adhesiveGsm: numOrUndef(body.adhesiveGsm2),
    };
    payload.releaseLiner2 = {
      releaseLinerType: trim(body.releaseLinerType2),
      releaseLinerMake: trim(body.releaseLinerMake2),
      releaseLinerSensing: sensingOrBlank(body.releaseLinerSensing2),
      releaseLinerVendorId: releaseLinerVendorId2 || undefined,
      releaseLinerVendorName: await resolveVendorName(releaseLinerVendorId2),
      releaseLinerVendorSkuCode: trim(body.releaseLinerVendorSkuCode2),
      releaseLinerColor: trim(body.releaseLinerColor2) || "WHITE",
      releaseLinerSize: trim(body.releaseLinerSize2),
      releaseLinerGsm: numOrUndef(body.releaseLinerGsm2),
    };
  }

  return payload;
}

// Same sha256 signature scheme used for Client/TapeSalesOrder/Facestock
// Master/Adhesive Master/Release Master/Label Stock Binding duplicate
// prevention (see routes/users/clients.js, routes/fairdesk_route.js,
// routes/system/facestockMaster.js, routes/sachiko/labelStockBinding.js) --
// blocks create/edit only when every field matches an existing record
// exactly, not just a similar recipe. buildLabelStockSignature/
// resolveLabelStockProductCode live in utils/labelStockVariant.js (not here)
// since produceDeckle() (utils/labelStockProduction.js, called from
// fairdesk_route.js's POST /labels/production/assign/:id) needs the exact
// same duplicate/variant logic when a raw-material substitution at
// production time turns out to be a materially different recipe -- see that
// file's own comment.
const DUPLICATE_LABELSTOCK_MESSAGE = "This Label Stock already exists (every field matches an existing record).";

router.post("/label-stock/form", requireAuth, createLimiter, handleWordUploadJson, async (req, res) => {
  try {
    const labelStockId = await generateId("sachikoLabelStockId", "LS");
    const payload = await buildLabelStockPayload(req.body);
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
    const newWordFile = labelStockFile(req, "wordFile");
    const newPdfFile = labelStockFile(req, "pdfFile");
    if (newWordFile) {
      payload.wordFile = newWordFile.filename;
      payload.wordFileOriginalName = newWordFile.originalname;
    }
    if (newPdfFile) {
      payload.pdfFile = newPdfFile.filename;
      payload.pdfFileOriginalName = newPdfFile.originalname;
    }

    // Product Code base is auto-assigned from the Family (CHROMO -> C001,
    // C002, ...): first letter of the Family + a running 3-digit sequence for
    // that letter. The dialog shows that base as a locked prefix; anything the
    // user typed after it is kept as a free-text suffix appended to the
    // server's own freshly computed base (so a stale client-side prefix can't
    // leak in). An identical recipe under an existing code is still rejected
    // -- the full-signature check below can't catch it now that the base is
    // generated and so never collides on its own.
    const specMatch = await findLabelStockSpecMatch(payload);
    if (specMatch) {
      throw Object.assign(new Error("Duplicate Label Stock combination"), {
        userMessage: `This exact combination already exists as Product Code "${specMatch.productCode}".`,
      });
    }
    // TEMPORARY (until every Label Stock code is serialized): a typed
    // "<letter><digits>" head is honoured exactly as entered instead of being
    // stripped and replaced by the generated base, so an operator can pin a
    // specific code by hand from the create dialog. Type no head and the base
    // is still generated as before, with whatever was typed kept as the
    // suffix. To go back to fully-automatic codes, drop this branch and make
    // #lsProductCodePrefix in views/sachiko/labelStockView.ejs readonly again.
    const typedProductCode = trim(payload.productCode).toUpperCase();
    if (/^[A-Z]\d{3,}/.test(typedProductCode)) {
      // productCode has no unique index, and variant resolution looks a base
      // up with findOne({ productCode }) -- two rows sharing a code would make
      // that pick an arbitrary one, so refuse the clash outright.
      const codeClash = await SachikoLabelStock.findOne({ productCode: typedProductCode })
        .select("productCode")
        .lean();
      if (codeClash) {
        throw Object.assign(new Error("Duplicate Product Code"), {
          userMessage: `Product Code "${typedProductCode}" is already in use. Enter a different code.`,
        });
      }
      payload.productCode = typedProductCode;
    } else {
      const productCodeBase = await generateFamilyProductCode(payload.family);
      payload.productCode = productCodeBase + typedProductCode;
    }
    const skuCode = await resolveLabelStockSkuCode(payload.productCode);

    const labelStockSignature = buildLabelStockSignature(payload);
    const existingSignature = await SachikoLabelStock.findOne({ labelStockSignature }).select("_id").lean();
    if (existingSignature) {
      throw Object.assign(new Error("Duplicate Label Stock"), { userMessage: DUPLICATE_LABELSTOCK_MESSAGE });
    }

    const materialSignature = buildMaterialSignature(payload);
    await SachikoLabelStock.create({ labelStockId, skuCode, ...payload, labelStockSignature, materialSignature });
    req.flash("notification", `Label Stock "${payload.productCode}" created successfully!`);
    res.json({ success: true, redirect: "/sachiko/label-stock/view" });
  } catch (err) {
    console.error("SACHIKO LABEL STOCK CREATE ERROR:", err);
    allLabelStockFiles(req).forEach((f) => {
      const p = path.join(LABEL_STOCK_UPLOAD_DIR, f.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    if (err?.code === 11000 && err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "labelStockSignature")) {
      return res.status(400).json({ success: false, message: DUPLICATE_LABELSTOCK_MESSAGE });
    }
    res.status(400).json({ success: false, message: err.userMessage || "Failed to create Label Stock" });
  }
});

// Editing now happens in a dialog on /sachiko/label-stock/view (see
// openEditLabelStockDialog in labelStockView.ejs, mirroring
// openCreateLabelStockDialog) instead of a standalone page -- this GET only
// exists so old bookmarks/links to that page still land somewhere.
router.get("/label-stock/edit/:id", (req, res) => {
  res.redirect("/sachiko/label-stock/view");
});

router.post("/label-stock/edit/:id", requireAuth, updateLimiter, handleWordUploadJson, async (req, res) => {
  try {
    const existing = await SachikoLabelStock.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Label Stock not found" });
    }

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

    const newWordFile = labelStockFile(req, "wordFile");
    const newPdfFile = labelStockFile(req, "pdfFile");
    if (newWordFile) {
      // Remove the previous file before swapping in the new one.
      if (existing.wordFile) {
        const oldPath = path.join(LABEL_STOCK_UPLOAD_DIR, existing.wordFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      payload.wordFile = newWordFile.filename;
      payload.wordFileOriginalName = newWordFile.originalname;
    }
    if (newPdfFile) {
      if (existing.pdfFile) {
        const oldPath = path.join(LABEL_STOCK_UPLOAD_DIR, existing.pdfFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      payload.pdfFile = newPdfFile.filename;
      payload.pdfFileOriginalName = newPdfFile.originalname;
    }

    // Recipe-level duplicate guard, same as the create route: a row edited to
    // exactly match another row's spec keeps its own (different) Product Code,
    // so the full-signature check below -- which includes Product Code -- would
    // never catch it. This does, comparing every field EXCEPT Product Code
    // against every other row.
    const specMatch = await findLabelStockSpecMatch(payload, { excludeId: req.params.id });
    if (specMatch) {
      throw Object.assign(new Error("Duplicate Label Stock combination"), {
        userMessage: `This exact combination already exists as Product Code "${specMatch.productCode}".`,
      });
    }

    // Product Code duplicate guard, same as the create route's: productCode
    // has no unique index, and variant resolution looks a base up with
    // findOne({ productCode }) (utils/labelStockVariant.js) -- two rows
    // sharing a code would make that pick an arbitrary one, so an edit that
    // would create the clash is refused outright. Stored uppercased the way
    // the create route stores a typed code.
    const productCode = trim(payload.productCode).toUpperCase();
    const codeClash = await SachikoLabelStock.findOne({
      _id: { $ne: req.params.id },
      productCode,
    })
      .select("productCode")
      .lean();
    if (codeClash) {
      throw Object.assign(new Error("Duplicate Product Code"), {
        userMessage: `Product Code "${productCode}" is already in use. Enter a different code.`,
      });
    }
    payload.productCode = productCode;

    const labelStockSignature = buildLabelStockSignature(payload);
    const existingSignature = await SachikoLabelStock.findOne({
      _id: { $ne: req.params.id },
      labelStockSignature,
    }).select("_id").lean();
    if (existingSignature) {
      throw Object.assign(new Error("Duplicate Label Stock"), { userMessage: DUPLICATE_LABELSTOCK_MESSAGE });
    }
    payload.labelStockSignature = labelStockSignature;
    payload.materialSignature = buildMaterialSignature(payload);

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
    res.json({ success: true, redirect: "/sachiko/label-stock/view" });
  } catch (err) {
    console.error("SACHIKO LABEL STOCK UPDATE ERROR:", err);
    allLabelStockFiles(req).forEach((f) => {
      const p = path.join(LABEL_STOCK_UPLOAD_DIR, f.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    if (err?.code === 11000 && err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "labelStockSignature")) {
      return res.status(400).json({ success: false, message: DUPLICATE_LABELSTOCK_MESSAGE });
    }
    res.status(400).json({ success: false, message: err.userMessage || "Failed to update Label Stock" });
  }
});

router.get("/label-stock/file/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(LABEL_STOCK_UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  const ds = await SachikoLabelStock.findOne({ $or: [{ wordFile: filename }, { pdfFile: filename }] })
    .select("wordFile wordFileOriginalName pdfFile pdfFileOriginalName")
    .lean();
  const originalName = (ds?.wordFile === filename ? ds.wordFileOriginalName : ds?.pdfFileOriginalName) || filename;
  res.setHeader("Content-Disposition", `inline; filename="${originalName}"`);
  res.sendFile(filePath);
});

router.delete("/label-stock/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ds = await SachikoLabelStock.findByIdAndDelete(req.params.id);
    if (!ds) {
      return res.status(404).json({ success: false, message: "Label Stock not found" });
    }
    for (const field of ["wordFile", "pdfFile"]) {
      if (!ds[field]) continue;
      const filePath = path.join(LABEL_STOCK_UPLOAD_DIR, ds[field]);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("SACHIKO LABEL STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete Label Stock" });
  }
});

/* ================= JOB CARD ================= */
// Disabled and removed from the side-nav -- superseded by the machine-queue-
// driven "Production Records" page (/sachiko/machine/jobcard/view).
router.get("/jobcard/view", (req, res) => {
  res.status(404).render("errors/notFound", {
    title: "Page Not Found",
    CSS: false,
    JS: false,
    homeLabel: "Back to Dashboard",
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
      poDate: b.poDate ? new Date(b.poDate) : undefined,
      poNumber: trim(b.poNumber),
      estimatedDate: b.estimatedDate ? new Date(b.estimatedDate) : undefined,
      remarks: trim(b.remarks),
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
