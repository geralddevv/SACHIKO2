import express from "express";
import crypto from "crypto";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import { buildLabelStockSignature, buildMaterialSignature } from "../../utils/labelStockVariant.js";
import Vendor from "../../models/users/vendor.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Same sha256 signature scheme used for Client/TapeSalesOrder/Label Stock
// Binding duplicate prevention (see routes/users/clients.js,
// routes/fairdesk_route.js, routes/sachiko/labelStockBinding.js) -- blocks
// create/edit only when every field matches an existing record exactly.
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildReleaseSignature(payload) {
  return hashSignature(
    [
      String(payload.vendorId || ""),
      canonStr(payload.type),
      canonStr(payload.make),
      canonStr(payload.sensing),
      canonStr(payload.vendorSkuCode),
      canonStr(payload.color),
      canonStr(payload.size),
      String(Number(payload.gsm ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_RELEASE_MESSAGE = "This release liner already exists (every field matches an existing record).";

// Every field ReleaseLinerStock mirrors from its master (see releaseSpecKey,
// routes/stock/releaseLinerStock.js -- stock is grouped under a master by
// matching all of these exactly). Editing a master must carry the same edit
// onto any reel still recorded under the pre-edit spec, or that reel quietly
// stops matching any master row and vanishes from the Stock/Allotted/
// Available columns even though the physical reel is still sitting there.
const STOCK_MIRROR_FIELDS = ["vendorId", "vendorName", "type", "make", "vendorSkuCode", "color", "size", "gsm"];

// Builds the query that finds every ReleaseLinerStock reel still carrying
// the master's PRE-edit identity, and the $set/$unset that brings them onto
// the post-edit one. A field that's now blank/undefined has to $unset, not
// $set with undefined -- Mongo/Mongoose silently drop undefined-valued $set
// keys, which would leave the old value in place.
function cascadeStockUpdate(before, payload) {
  const match = {};
  const $set = {};
  const $unset = {};
  for (const field of STOCK_MIRROR_FIELDS) {
    const oldVal = before[field];
    match[field] = oldVal === undefined || oldVal === null ? { $exists: false } : oldVal;

    const newVal = payload[field];
    if (newVal === undefined || newVal === null || newVal === "") $unset[field] = "";
    else $set[field] = newVal;
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  return { match, update };
}

// A SachikoLabelStock recipe carries its own denormalized copy of the
// Release Master it was built from, on releaseLiner (and releaseLiner2 for
// DOUBLE RELEASE) -- master field name -> recipe field name. Same idea as
// STOCK_MIRROR_FIELDS above, one level further out: the reel copies the
// master, and so does the recipe.
//
// `size` is deliberately absent: the Label Stock create/edit dialog has no
// Release Liner Size field at all (see FS_ORDER/AD_ORDER/RL_ORDER in
// views/sachiko/labelStockView.ejs and the comment there), so every
// manually-created recipe leaves it blank -- writing the master's Size onto
// those rows would change their labelStockSignature for a field the form
// never let anyone set.
const RECIPE_MIRROR_FIELDS = {
  type: "releaseLinerType",
  make: "releaseLinerMake",
  sensing: "releaseLinerSensing",
  vendorId: "releaseLinerVendorId",
  vendorName: "releaseLinerVendorName",
  vendorSkuCode: "releaseLinerVendorSkuCode",
  color: "releaseLinerColor",
  gsm: "releaseLinerGsm",
};

// Which of those identify "this recipe layer was built from THAT master" --
// everything except vendorName, a denormalized display copy that vendorId
// already pins down (a stale one is something this cascade should repair,
// not something it should refuse to match on). Sensing is included: once
// masters actually carry it, two masters can differ in nothing else, and a
// recipe still blank on it genuinely doesn't say which of the two it meant --
// better left alone than guessed at. Before any master has it, master and
// recipe are both blank, so the first fill still lands.
const RECIPE_MATCH_FIELDS = Object.keys(RECIPE_MIRROR_FIELDS).filter((f) => f !== "vendorName");

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

// Carries a master edit onto every Label Stock recipe layer built from its
// pre-edit spec, the same way cascadeStockUpdate does for physical reels --
// otherwise a recipe quietly stops describing any master row that exists.
// This is what fills Sensing in on recipes saved before any master had it:
// blank on the master pre-edit matches blank on the recipe, so setting it on
// the master pushes it down to every Label Stock using that liner.
//
// Not an updateMany: labelStockSignature/materialSignature are hashed off the
// recipe's own fields (utils/labelStockVariant.js), so every touched row has
// to be re-hashed or its signatures go stale and duplicate detection starts
// comparing against something the row no longer is. A row whose new signature
// would collide with an existing one is left untouched and counted separately
// -- two masters can't converge (the duplicate check above blocks that), so
// this only fires against a hand-built row that already looked like the
// post-edit spec, which is a human decision, not a guess for this code.
async function cascadeLabelStockRecipes(before, payload) {
  let updated = 0;
  let skipped = 0;

  for (const layer of ["releaseLiner", "releaseLiner2"]) {
    const query = {};
    for (const field of RECIPE_MATCH_FIELDS) {
      const oldVal = before[field];
      // `$in: [null, ""]` also matches a row where the key is absent
      // entirely -- both a legacy row saved before the field existed and a
      // NORMAL/DOUBLE FACESTOCK row that has no releaseLiner2 at all. The
      // latter can't slip through anyway: Release Master's `type` is
      // required, so the type clause is always a concrete value and only
      // matches rows that really do carry this layer.
      query[`${layer}.${RECIPE_MIRROR_FIELDS[field]}`] = isBlank(oldVal) ? { $in: [null, ""] } : oldVal;
    }

    for (const doc of await SachikoLabelStock.find(query)) {
      for (const [masterField, recipeField] of Object.entries(RECIPE_MIRROR_FIELDS)) {
        const newVal = payload[masterField];
        doc.set(`${layer}.${recipeField}`, isBlank(newVal) ? undefined : newVal);
      }
      const snapshot = doc.toObject();
      doc.labelStockSignature = buildLabelStockSignature(snapshot);
      doc.materialSignature = buildMaterialSignature(snapshot);
      try {
        await doc.save();
        updated += 1;
      } catch (err) {
        console.error(`RELEASE MASTER -> LABEL STOCK CASCADE SKIPPED (${doc.productCode}):`, err.message);
        skipped += 1;
      }
    }
  }

  return { updated, skipped };
}

// Same "SP | <CODE> | 000001" id scheme used for Machine/Label Stock/Job Card
const parseSkuSeq = (skuId) => {
  const match = String(skuId || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

// Generate a sequential id of the form `SP | REL | 000001`.
async function generateId(key, code) {
  const [latest, counter] = await Promise.all([
    ReleaseMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await ReleaseMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  await Counter.updateOne({ key }, { $set: { seq: nextSeq } }, { upsert: true });
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

async function previewId(key, code) {
  const [latest, counter] = await Promise.all([
    ReleaseMaster.findOne().sort({ skuId: -1 }).select("skuId").lean(),
    Counter.findOne({ key }).select("seq").lean(),
  ]);
  const maxSeq = Math.max(parseSkuSeq(latest?.skuId), Number(counter?.seq || 0));
  let nextSeq = maxSeq + 1;
  while (await ReleaseMaster.exists({ skuId: `SP | ${code} | ${String(nextSeq).padStart(6, "0")}` })) {
    nextSeq += 1;
  }
  return `SP | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const requireReleaseMaster = requireRole(["proprietor", "admin", "hod"]);

// The only two values the Sensing select offers -- anything else posted is
// treated as "not stated" (blank), matching the enum on releaseMaster.js.
const SENSING_OPTIONS = ["SENSING", "NON-SENSING"];

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

async function buildPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const payload = {
    vendorId,
    type: String(body.type || "").trim(),
    make: String(body.make || "").trim(),
    sensing: SENSING_OPTIONS.includes(String(body.sensing || "").trim().toUpperCase())
      ? String(body.sensing).trim().toUpperCase()
      : "",
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    msq: numOrUndef(body.msq),
  };

  if (vendorId) {
    const vendor = await Vendor.findById(vendorId).select("vendorName").lean();
    payload.vendorName = vendor?.vendorName || "";
  }

  return payload;
}

function validatePayload(payload) {
  if (!payload.vendorId || !payload.vendorName) return "Vendor Name is required.";
  if (!payload.type) return "Type is required.";
  return null;
}

router.get("/form/release", requireReleaseMaster, async (req, res) => {
  const [releases, previewSkuId, vendors] = await Promise.all([
    ReleaseMaster.find().sort({ skuId: 1 }).lean(),
    previewId("releaseMasterSkuId", "REL"),
    Vendor.find({ commodities: "RELEASE PAPER" }, { vendorName: 1 }).sort({ vendorName: 1 }).lean(),
  ]);
  res.render("inventory/masters/releaseMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Master",
    releases,
    previewSkuId,
    vendors,
    notification: req.flash("notification"),
  });
});

router.post("/form/release", requireAuth, requireReleaseMaster, createLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const releaseSignature = buildReleaseSignature(payload);
    const duplicate = await ReleaseMaster.exists({ releaseSignature });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_RELEASE_MESSAGE });
    }

    const skuId = await generateId("releaseMasterSkuId", "REL");
    await ReleaseMaster.create({ ...payload, skuId, releaseSignature });

    res.locals.auditDescription = `Created release master "${skuId}" (${payload.vendorName})`;
    req.flash("notification", "Release master created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/release" });
  } catch (err) {
    console.error("RELEASE MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "releaseSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_RELEASE_MESSAGE : "Failed to create release master." });
  }
});

router.put("/api/release/:id", requireAuth, requireReleaseMaster, updateLimiter, async (req, res) => {
  try {
    const payload = await buildPayload(req.body);
    const error = validatePayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const releaseSignature = buildReleaseSignature(payload);
    const duplicate = await ReleaseMaster.exists({ releaseSignature, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_RELEASE_MESSAGE });
    }

    const before = await ReleaseMaster.findById(req.params.id).lean();
    if (!before) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }

    const updated = await ReleaseMaster.findByIdAndUpdate(req.params.id, { ...payload, releaseSignature }, { new: true, runValidators: true });

    const { match, update } = cascadeStockUpdate(before, payload);
    let stockUpdated = 0;
    if (update.$set || update.$unset) {
      const result = await ReleaseLinerStock.updateMany(match, update);
      stockUpdated = result.modifiedCount || 0;
    }

    // ...and the same edit onto every Label Stock recipe built from this
    // master (see cascadeLabelStockRecipes) -- notably how Sensing reaches
    // recipes that were saved while every master still had it blank.
    const { updated: recipesUpdated, skipped: recipesSkipped } = await cascadeLabelStockRecipes(before, payload);

    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const carried = [
      stockUpdated ? plural(stockUpdated, "stock reel") : null,
      recipesUpdated ? plural(recipesUpdated, "label stock recipe") : null,
    ].filter(Boolean).join(" and ");

    res.locals.auditDescription = `Updated release master "${updated.skuId}"`
      + (carried ? ` -- carried the change onto ${carried}` : "")
      + (recipesSkipped ? ` (${plural(recipesSkipped, "label stock")} skipped -- see server log)` : "");
    req.flash("notification", carried
      ? `Release master updated -- ${carried} updated to match.`
        + (recipesSkipped ? ` ${plural(recipesSkipped, "label stock")} could not be updated (would duplicate an existing recipe).` : "")
      : "Release master updated successfully!");
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "releaseSignature");
    res.status(400).json({ success: false, message: isDup ? DUPLICATE_RELEASE_MESSAGE : "Failed to update release master." });
  }
});

router.delete("/api/release/:id", requireAuth, requireReleaseMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await ReleaseMaster.findByIdAndDelete(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release master not found." });
    }
    res.locals.auditDescription = `Deleted release master "${existing.skuId}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("RELEASE MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete release master." });
  }
});

export default router;
