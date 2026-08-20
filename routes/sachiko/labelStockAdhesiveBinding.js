import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import AdhesiveMaster from "../../models/inventory/adhesiveMaster.js";
import LabelStockAdhesiveBinding from "../../models/sachiko/labelStockAdhesiveBinding.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const PAGE = "/sachiko/form/label-stock-adhesive-binding";

// Same sha256 signature scheme the Client Label Stock binding uses (see
// routes/sachiko/labelStockBinding.js) -- applied here to "same SKU, same
// adhesive".
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function buildBindingSignature({ labelStock, adhesive }) {
  return hashSignature([String(labelStock || ""), String(adhesive || "")].join("||"));
}

const DUPLICATE_MESSAGE = "This adhesive is already bound to that Label Stock.";

// One row's worth of the submitted form, validated. Returns { payload } or
// { error } -- never throws, so every caller can flash-and-redirect the same
// way.
async function readBindingBody(body) {
  const labelStockId = String(body.labelStockId || "").trim();
  const adhesiveId = String(body.adhesiveId || "").trim();

  if (!mongoose.isValidObjectId(labelStockId)) return { error: "Please select a Label Stock." };
  if (!mongoose.isValidObjectId(adhesiveId)) return { error: "Please select an Adhesive." };

  const [labelStock, adhesive] = await Promise.all([
    SachikoLabelStock.exists({ _id: labelStockId }),
    AdhesiveMaster.exists({ _id: adhesiveId }),
  ]);
  if (!labelStock) return { error: "That Label Stock no longer exists." };
  if (!adhesive) return { error: "That Adhesive Master no longer exists." };

  return {
    payload: {
      labelStock: labelStockId,
      adhesive: adhesiveId,
      bindingSignature: buildBindingSignature({ labelStock: labelStockId, adhesive: adhesiveId }),
    },
  };
}

// The form plus everything already bound, on one page -- these bindings are
// short rows (SKU, adhesive) with nothing worth its own view screen,
// so the list lives under the form and edits happen in a dialog on it.
router.get("/form/label-stock-adhesive-binding", async (req, res) => {
  try {
    const [labelStocks, adhesives, bindings] = await Promise.all([
      // Full recipe layers included (not just `adhesive`) -- the Bind dialog
      // shows the whole layer stack for context once a Product Code is picked
      // (see views/sachiko/labelStockAdhesiveBindingForm.ejs's layer preview).
      SachikoLabelStock.find(
        {},
        {
          skuCode: 1,
          productCode: 1,
          rollType: 1,
          facestock: 1,
          adhesive: 1,
          releaseLiner: 1,
          facestock2: 1,
          adhesive2: 1,
          releaseLiner2: 1,
        },
      )
        .sort({ productCode: 1, skuCode: 1 })
        .lean(),
      // Every field the Bind dialog's smart cascading filter narrows on (see
      // AD_ORDER in the view) plus vendorId, so the cascade can resolve down
      // to one Adhesive Master and read off its skuId.
      AdhesiveMaster.find(
        {},
        {
          skuId: 1,
          vendorId: 1,
          vendorName: 1,
          type: 1,
          make: 1,
          vendorSkuCode: 1,
          shelfLife: 1,
          viscosity: 1,
          cohesion: 1,
          shear: 1,
          density: 1,
        },
      )
        .sort({ skuId: 1 })
        .lean(),
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
