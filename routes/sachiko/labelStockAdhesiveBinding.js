import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import LabelStockAdhesiveBinding from "../../models/sachiko/labelStockAdhesiveBinding.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const PAGE = "/sachiko/form/label-stock-adhesive-binding";

// Same sha256 signature scheme the Client Label Stock binding uses (see
// routes/sachiko/labelStockBinding.js) -- applied here to "same SKU, same
// adhesive, same location".
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonLocation(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildBindingSignature({ labelStock, adhesive, location }) {
  return hashSignature([String(labelStock || ""), String(adhesive || ""), canonLocation(location)].join("||"));
}

const DUPLICATE_MESSAGE =
  "This adhesive is already bound to that Label Stock for the same location.";

// One row's worth of the submitted form, validated. Returns { payload } or
// { error } -- never throws, so every caller can flash-and-redirect the same
// way.
async function readBindingBody(body) {
  const labelStockId = String(body.labelStockId || "").trim();
  const adhesiveId = String(body.adhesiveId || "").trim();
  const location = String(body.location || "").trim();

  if (!mongoose.isValidObjectId(labelStockId)) return { error: "Please select a Label Stock." };
  if (!mongoose.isValidObjectId(adhesiveId)) return { error: "Please select an Adhesive." };

  const [labelStock, adhesive] = await Promise.all([
    SachikoLabelStock.exists({ _id: labelStockId }),
    AdhesiveMaster.exists({ _id: adhesiveId }),
  ]);
  if (!labelStock) return { error: "That Label Stock no longer exists." };
  if (!adhesive) return { error: "That Adhesive Master no longer exists." };

  // Blank is a real value here -- "binds everywhere" -- so only a location
  // that was actually typed gets checked against the master list.
  if (location) {
    const known = await Location.exists({ locationName: location });
    if (!known) return { error: "Invalid location." };
  }

  return {
    payload: {
      labelStock: labelStockId,
      adhesive: adhesiveId,
      location,
      bindingSignature: buildBindingSignature({ labelStock: labelStockId, adhesive: adhesiveId, location }),
    },
  };
}

// The form plus everything already bound, on one page -- these bindings are
// short rows (SKU, adhesive, location) with nothing worth its own view screen,
// so the list lives under the form and edits happen in a dialog on it.
router.get("/form/label-stock-adhesive-binding", async (req, res) => {
  try {
    const [labelStocks, adhesives, locations, bindings] = await Promise.all([
      SachikoLabelStock.find({}, { skuCode: 1, productCode: 1, rollType: 1, adhesive: 1 })
        .sort({ productCode: 1, skuCode: 1 })
        .lean(),
      AdhesiveMaster.find({}, { skuId: 1, type: 1, make: 1, vendorName: 1, vendorSkuCode: 1 })
        .sort({ skuId: 1 })
        .lean(),
      Location.find({}, { locationName: 1 }).sort({ locationName: 1 }).lean(),
      LabelStockAdhesiveBinding.find()
        .populate({ path: "labelStock", select: "skuCode productCode adhesive" })
        .populate({ path: "adhesive", select: "skuId type make vendorName vendorSkuCode" })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.render("sachiko/labelStockAdhesiveBindingForm.ejs", {
      title: "Label Stock Adhesive",
      CSS: "tableDisp.css",
      JS: false,
      labelStocks,
      adhesives,
      locations: locations.map((l) => l.locationName),
      bindings,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("LABEL STOCK ADHESIVE BINDING LOAD ERROR:", err);
    req.flash("notification", "Failed to load Label Stock Adhesive Binding.");
    res.redirect(req.get("Referrer") || "/sachiko/label-stock/view");
  }
});

router.post("/form/label-stock-adhesive-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { payload, error } = await readBindingBody(req.body);
    if (error) {
      req.flash("notification", error);
      return res.redirect(PAGE);
    }

    // The unique index on bindingSignature is the real guard (two people
    // saving the same pair at once); this check exists to answer with a
    // readable message in the ordinary case.
    if (await LabelStockAdhesiveBinding.exists({ bindingSignature: payload.bindingSignature })) {
      req.flash("notification", DUPLICATE_MESSAGE);
      return res.redirect(PAGE);
    }

    const created = await LabelStockAdhesiveBinding.create(payload);
    res.locals.auditDescription = `Bound adhesive ${payload.adhesive} to label stock ${payload.labelStock}`;
    req.flash("notification", `Adhesive bound successfully (${created._id}).`);
    res.redirect(PAGE);
  } catch (err) {
    if (err?.code === 11000) {
      req.flash("notification", DUPLICATE_MESSAGE);
      return res.redirect(PAGE);
    }
    console.error("LABEL STOCK ADHESIVE BINDING SAVE ERROR:", err);
    req.flash("notification", "Failed to save the binding.");
    res.redirect(PAGE);
  }
});

router.post("/label-stock-adhesive-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid binding id.");
      return res.redirect(PAGE);
    }

    const { payload, error } = await readBindingBody(req.body);
    if (error) {
      req.flash("notification", error);
      return res.redirect(PAGE);
    }

    const clash = await LabelStockAdhesiveBinding.exists({
      bindingSignature: payload.bindingSignature,
      _id: { $ne: id },
    });
    if (clash) {
      req.flash("notification", DUPLICATE_MESSAGE);
      return res.redirect(PAGE);
    }

    const updated = await LabelStockAdhesiveBinding.findByIdAndUpdate(id, { $set: payload }, { new: true });
    if (!updated) {
      req.flash("notification", "Binding not found.");
      return res.redirect(PAGE);
    }

    res.locals.auditDescription = `Updated label stock adhesive binding ${id}`;
    req.flash("notification", "Binding updated.");
    res.redirect(PAGE);
  } catch (err) {
    if (err?.code === 11000) {
      req.flash("notification", DUPLICATE_MESSAGE);
      return res.redirect(PAGE);
    }
    console.error("LABEL STOCK ADHESIVE BINDING EDIT ERROR:", err);
    req.flash("notification", "Failed to update the binding.");
    res.redirect(PAGE);
  }
});

// ACTIVE/INACTIVE rather than delete-only: switching a binding off narrows
// nothing (an inactive one is ignored by the picker) but keeps the record of
// what was once allowed.
router.post("/label-stock-adhesive-binding/status/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body.status || "").trim().toUpperCase();
    if (!mongoose.isValidObjectId(id) || !["ACTIVE", "INACTIVE"].includes(status)) {
      req.flash("notification", "Invalid request.");
      return res.redirect(PAGE);
    }

    const updated = await LabelStockAdhesiveBinding.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    if (!updated) {
      req.flash("notification", "Binding not found.");
      return res.redirect(PAGE);
    }

    res.locals.auditDescription = `Set label stock adhesive binding ${id} to ${status}`;
    req.flash("notification", `Binding set to ${status}.`);
    res.redirect(PAGE);
  } catch (err) {
    console.error("LABEL STOCK ADHESIVE BINDING STATUS ERROR:", err);
    req.flash("notification", "Failed to change the binding's status.");
    res.redirect(PAGE);
  }
});

router.post("/label-stock-adhesive-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid binding id.");
      return res.redirect(PAGE);
    }

    const deleted = await LabelStockAdhesiveBinding.findByIdAndDelete(id);
    if (!deleted) {
      req.flash("notification", "Binding not found.");
      return res.redirect(PAGE);
    }

    res.locals.auditDescription = `Deleted label stock adhesive binding ${id}`;
    req.flash("notification", "Binding deleted.");
    res.redirect(PAGE);
  } catch (err) {
    console.error("LABEL STOCK ADHESIVE BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to delete the binding.");
    res.redirect(PAGE);
  }
});

export default router;
