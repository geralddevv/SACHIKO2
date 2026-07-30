import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import Counter from "../../models/system/counter.js";
import SachikoSL from "../../models/sachiko/sachikoSL.js";
import SachikoJobcard from "../../models/sachiko/sachikoJobcard.js";
import SachikoSalesOrder from "../../models/sachiko/sachikoSalesOrder.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* ================= FILE UPLOAD (SL WORD FILE) ================= */
const SL_UPLOAD_DIR = path.resolve("uploads/sachiko/sls");
fs.mkdirSync(SL_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SL_UPLOAD_DIR),
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

/* ================= SL ================= */
router.get("/sl/view", async (req, res) => {
  const jsonData = await SachikoSL.find().sort({ productCode: 1 }).lean();
  res.render("sachiko/slView.ejs", {
    title: "SL View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/sl/form", async (req, res) => {
  res.render("sachiko/slForm.ejs", {
    title: "SL Form",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

function buildSLPayload(body) {
  return {
    productCode: trim(body.productCode),
    facestock: {
      facestockFamily: trim(body.facestockFamily),
      facestockType: trim(body.facestockType),
      facestockGsm: numOrUndef(body.facestockGsm),
      facestockMicron: numOrUndef(body.facestockMicron),
    },
    adhesive: {
      adhesiveType: trim(body.adhesiveType),
      adhesiveGsm: numOrUndef(body.adhesiveGsm),
    },
    releaseLiner: {
      releaseLinerType: trim(body.releaseLinerType),
      releaseLinerColor: trim(body.releaseLinerColor) || "WHITE",
      releaseLinerGsm: numOrUndef(body.releaseLinerGsm),
    },
  };
}

router.post("/sl/form", requireAuth, createLimiter, handleWordUpload, async (req, res) => {
  try {
    const slId = await generateId("sachikoSLId", "SL");
    const payload = buildSLPayload(req.body);
    if (req.file) {
      payload.wordFile = req.file.filename;
      payload.wordFileOriginalName = req.file.originalname;
    }
    await SachikoSL.create({ slId, ...payload });
    req.flash("notification", "SL created successfully!");
    res.redirect("/sachiko/sl/view");
  } catch (err) {
    console.error("SACHIKO SL CREATE ERROR:", err);
    if (req.file) fs.existsSync(path.join(SL_UPLOAD_DIR, req.file.filename)) && fs.unlinkSync(path.join(SL_UPLOAD_DIR, req.file.filename));
    req.flash("notification", "Failed to create SL");
    res.redirect("/sachiko/sl/form");
  }
});

router.get("/sl/edit/:id", async (req, res) => {
  const ds = await SachikoSL.findById(req.params.id).lean();
  if (!ds) {
    req.flash("notification", "SL not found");
    return res.redirect("/sachiko/sl/view");
  }
  res.render("sachiko/slEdit.ejs", {
    title: "Edit SL",
    CSS: false,
    JS: false,
    ds,
    notification: req.flash("notification"),
  });
});

router.post("/sl/edit/:id", requireAuth, updateLimiter, handleWordUpload, async (req, res) => {
  try {
    const existing = await SachikoSL.findById(req.params.id);
    if (!existing) {
      req.flash("notification", "SL not found");
      return res.redirect("/sachiko/sl/view");
    }

    const payload = buildSLPayload(req.body);

    if (req.file) {
      // Remove the previous file before swapping in the new one.
      if (existing.wordFile) {
        const oldPath = path.join(SL_UPLOAD_DIR, existing.wordFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      payload.wordFile = req.file.filename;
      payload.wordFileOriginalName = req.file.originalname;
    }

    await SachikoSL.findByIdAndUpdate(req.params.id, payload);
    req.flash("notification", "SL updated successfully!");
    res.redirect("/sachiko/sl/view");
  } catch (err) {
    console.error("SACHIKO SL UPDATE ERROR:", err);
    req.flash("notification", "Failed to update SL");
    res.redirect(`/sachiko/sl/edit/${req.params.id}`);
  }
});

router.get("/sl/file/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(SL_UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  const ds = await SachikoSL.findOne({ wordFile: filename }).select("wordFileOriginalName").lean();
  res.download(filePath, ds?.wordFileOriginalName || filename);
});

router.delete("/sl/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ds = await SachikoSL.findByIdAndDelete(req.params.id);
    if (!ds) {
      return res.status(404).json({ success: false, message: "SL not found" });
    }
    if (ds.wordFile) {
      const filePath = path.join(SL_UPLOAD_DIR, ds.wordFile);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("SACHIKO SL DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete SL" });
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
  const sls = await SachikoSL.find().sort({ productCode: 1 }).lean();
  const previewLotNo = await previewId("sachikoLotNo", "LOT");
  res.render("sachiko/jobcardForm.ejs", {
    title: "Job Card Form",
    CSS: false,
    JS: false,
    sls,
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
  const [clients, clientUsers, sls] = await Promise.all([
    Client.find().select("clientId clientName").sort({ clientName: 1 }).lean(),
    Username.find().select("clientId userName").lean(),
    SachikoSL.find().sort({ productCode: 1 }).lean(),
  ]);
  const previewSalesOrderId = await previewId("sachikoSalesOrderId", "SO");
  res.render("sachiko/salesOrderForm.ejs", {
    title: "Sales Order",
    CSS: false,
    JS: false,
    clients,
    clientUsers,
    sls,
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
