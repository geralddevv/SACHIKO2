import express from "express";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollIds } from "../../utils/materialRollId.js";

const router = express.Router();
const ROLL_ID_PREFIX = "ADHESIVE";
const MAX_DRUMS_PER_BATCH = 100;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

// Fields shared by every drum in one inward batch (one spec, one invoice).
function buildHeaderPayload(body) {
  return {
    type: String(body.type || "").trim(),
    gsm: numOrUndef(body.gsm),
    location: String(body.location || "").trim(),
    rate: numOrUndef(body.rate),
    invoiceNo: String(body.invoiceNo || "").trim(),
    remarks: String(body.remarks || "").trim(),
  };
}

function validateHeaderPayload(header) {
  if (!header.type) return "Type is required.";
  if (!header.location) return "Location is required.";
  return null;
}

// Per-drum fields -- one physical drum of the batch's shared spec.
function buildDrumPayload(raw) {
  return {
    reelMtrs: Number(raw?.reelMtrs),
    vendorRollId: String(raw?.vendorRollId || "").trim(),
  };
}

// The Edit dialog still edits one existing drum at a time (its own Roll ID
// is already assigned, so there's nothing to batch) -- full single-drum
// payload, same shape as the pre-batch /create used.
function buildEditPayload(body) {
  return { ...buildHeaderPayload(body), ...buildDrumPayload(body) };
}

function validateEditPayload(payload) {
  const headerError = validateHeaderPayload(payload);
  if (headerError) return headerError;
  if (!payload.reelMtrs || payload.reelMtrs <= 0) return "Mtrs is required.";
  return null;
}

router.get("/", async (req, res) => {
  const [locations, stock] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    AdhesiveStock.find().sort({ createdAt: -1 }).lean(),
  ]);
  res.render("stock/adhesiveStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Adhesive Stock",
    locations,
    stock,
    notification: req.flash("notification"),
  });
});

// Read-only preview of the next `count` Roll IDs -- refreshed by the add
// dialog whenever "No of Drums" changes, so row 1 always shows the lowest id
// and they read as a consecutive run. Doesn't consume the sequence.
router.get("/preview-roll-ids", async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), MAX_DRUMS_PER_BATCH);
  const rollIds = await previewMaterialRollIds(ROLL_ID_PREFIX, count);
  res.json({ rollIds });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const header = buildHeaderPayload(req.body);
    const headerError = validateHeaderPayload(header);
    if (headerError) return res.status(400).json({ success: false, message: headerError });

    const rawDrums = Array.isArray(req.body.rolls) ? req.body.rolls : [];
    if (!rawDrums.length) return res.status(400).json({ success: false, message: "At least one drum is required." });
    if (rawDrums.length > MAX_DRUMS_PER_BATCH) {
      return res.status(400).json({ success: false, message: `A batch can hold at most ${MAX_DRUMS_PER_BATCH} drums.` });
    }

    const drums = rawDrums.map(buildDrumPayload);
    const invalidIndex = drums.findIndex((d) => !d.reelMtrs || d.reelMtrs <= 0);
    if (invalidIndex !== -1) {
      return res.status(400).json({ success: false, message: `Mtrs is required for drum ${invalidIndex + 1}.` });
    }

    const locationExists = await Location.exists({ locationName: header.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const createdRollIds = [];
    for (const drum of drums) {
      const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, AdhesiveStock);
      await AdhesiveStock.create({ ...header, ...drum, rollId });
      createdRollIds.push(rollId);
    }

    res.locals.auditDescription = `Added ${createdRollIds.length} adhesive stock drum(s) (${header.type}) at "${header.location}": ${createdRollIds.join(", ")}`;
    req.flash("notification", `${createdRollIds.length} adhesive drum(s) added successfully!`);
    res.json({ success: true, redirect: "/sachiko/adhesivestock" });
  } catch (err) {
    console.error("ADHESIVE STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add adhesive stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const payload = buildEditPayload(req.body);
    const error = validateEditPayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const locationExists = await Location.exists({ locationName: payload.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const updated = await AdhesiveStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Adhesive stock drum not found." });
    }

    res.locals.auditDescription = `Updated adhesive stock drum "${updated.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE STOCK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update adhesive stock." });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await AdhesiveStock.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Adhesive stock drum not found." });
    }
    res.locals.auditDescription = `Deleted adhesive stock drum "${existing.rollId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("ADHESIVE STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete adhesive stock." });
  }
});

export default router;
