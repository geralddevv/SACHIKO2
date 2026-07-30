import express from "express";
import SachikoSL from "../../models/sachiko/sachikoSL.js";
import SLBinding from "../../models/sachiko/slBinding.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { getUserLocationNames } from "../../utils/locations.js";

const router = express.Router();

// Flat field id (used by the form/JS) -> the SachikoSL document path it matches.
const SPEC_FIELDS = {
  fsFamily: "facestock.facestockFamily",
  fsType: "facestock.facestockType",
  fsGsm: "facestock.facestockGsm",
  fsMicron: "facestock.facestockMicron",
  adType: "adhesive.adhesiveType",
  adGsm: "adhesive.adhesiveGsm",
  rlType: "releaseLiner.releaseLinerType",
  rlColor: "releaseLiner.releaseLinerColor",
  rlGsm: "releaseLiner.releaseLinerGsm",
};

// Tolerate a value coming in as either a string or a number (GSM/Micron are
// stored as Numbers on SachikoSL, but query params always arrive as strings).
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

/* GET : Load SL Binding Form */
router.get("/form/sl-binding", async (req, res) => {
  try {
    const [clients, fsFamilies, fsTypes, fsGsms, fsMicrons, adTypes, adGsms, rlTypes, rlColors, rlGsms] = await Promise.all([
      Client.distinct("clientName"),
      SachikoSL.distinct("facestock.facestockFamily"),
      SachikoSL.distinct("facestock.facestockType"),
      SachikoSL.distinct("facestock.facestockGsm"),
      SachikoSL.distinct("facestock.facestockMicron"),
      SachikoSL.distinct("adhesive.adhesiveType"),
      SachikoSL.distinct("adhesive.adhesiveGsm"),
      SachikoSL.distinct("releaseLiner.releaseLinerType"),
      SachikoSL.distinct("releaseLiner.releaseLinerColor"),
      SachikoSL.distinct("releaseLiner.releaseLinerGsm"),
    ]);

    res.render("sachiko/slBinding.ejs", {
      title: "Client SL",
      clients,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      fsFamilies,
      fsTypes,
      fsGsms,
      fsMicrons,
      adTypes,
      adGsms,
      rlTypes,
      rlColors,
      rlGsms,
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load SL Binding");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Save SL Binding */
router.post("/form/sl-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, slId } = req.body;
    const location = String(req.body.location || "").trim();

    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }

    if (!slId) {
      return res.status(400).json({ success: false, message: "Please resolve a valid SL before saving" });
    }

    const existingBinding = await SLBinding.exists({ userId, sl: slId, location });
    if (existingBinding) {
      return res.status(400).json({ success: false, message: "This SL is already bound to this user at this location." });
    }

    const binding = await SLBinding.create({ sl: slId, userId, location });

    user.sl.push(binding._id);
    await user.save();

    res.locals.auditDescription = `Created SL binding for "${user.userName}"`;
    req.flash("notification", "SL binding created successfully!");
    res.json({ success: true, redirect: "/sachiko/client/details/" + userId });
  } catch (err) {
    console.error("SL BINDING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create SL binding." });
  }
});

/* GET : Display a client's bound SLs */
router.get("/sl-binding/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({ path: "sl", populate: { path: "sl", model: "SachikoSL" } })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    res.render("sachiko/slBindingDisp.ejs", {
      jsonData: user.sl || [],
      CSS: "tableDisp.css",
      JS: false,
      title: "SL Binding Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("SL BINDING VIEW ERROR:", err);
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Delete an SL binding */
router.post("/sl-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const binding = await SLBinding.findById(req.params.id).select("userId").lean();
    if (!binding) {
      req.flash("notification", "SL binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    await SLBinding.deleteOne({ _id: req.params.id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { sl: req.params.id } });

    res.locals.auditDescription = `Deleted SL binding for user ${binding.userId}`;
    req.flash("notification", "SL binding removed successfully!");
    return res.redirect(`/sachiko/sl-binding/view/${binding.userId}`);
  } catch (err) {
    console.error("SL BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove SL binding");
    return res.redirect("back");
  }
});

/* GET : Load SL Binding Edit Form */
router.get("/sl-binding/edit/:id", async (req, res) => {
  try {
    const binding = await SLBinding.findById(req.params.id).populate("sl").populate("userId");
    if (!binding) {
      req.flash("notification", "SL binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const [fsFamilies, fsTypes, fsGsms, fsMicrons, adTypes, adGsms, rlTypes, rlColors, rlGsms] = await Promise.all([
      SachikoSL.distinct("facestock.facestockFamily"),
      SachikoSL.distinct("facestock.facestockType"),
      SachikoSL.distinct("facestock.facestockGsm"),
      SachikoSL.distinct("facestock.facestockMicron"),
      SachikoSL.distinct("adhesive.adhesiveType"),
      SachikoSL.distinct("adhesive.adhesiveGsm"),
      SachikoSL.distinct("releaseLiner.releaseLinerType"),
      SachikoSL.distinct("releaseLiner.releaseLinerColor"),
      SachikoSL.distinct("releaseLiner.releaseLinerGsm"),
    ]);

    res.render("sachiko/slBindingEdit.ejs", {
      title: "Edit SL Binding",
      binding,
      userLocations: getUserLocationNames(binding.userId, binding.location),
      fsFamilies, fsTypes, fsGsms, fsMicrons, adTypes, adGsms, rlTypes, rlColors, rlGsms,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("SL BINDING EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load SL Binding Edit");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Update SL Binding */
router.post("/sl-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { slId: newSl } = req.body;

    const binding = await SLBinding.findById(id);
    if (!binding) {
      req.flash("notification", "SL binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const location = String(req.body.location || "").trim() || binding.location;
    if (!location) {
      req.flash("notification", "Please select a location");
      return res.redirect(req.get("Referrer") || "/");
    }

    const targetSl = newSl && /^[a-f\d]{24}$/i.test(newSl) ? newSl : binding.sl;

    const duplicate = await SLBinding.exists({
      _id: { $ne: id },
      userId: binding.userId,
      sl: targetSl,
      location,
    });
    if (duplicate) {
      req.flash("notification", "This SL is already bound to this user at this location.");
      return res.redirect(req.get("Referrer") || "/");
    }

    binding.sl = targetSl;
    binding.location = location;
    await binding.save();

    res.locals.auditDescription = `Updated SL binding for user ${binding.userId}`;
    req.flash("notification", "SL binding updated successfully!");
    res.redirect(`/sachiko/sl-binding/view/${binding.userId}`);
  } catch (err) {
    console.error("SL BINDING EDIT POST ERROR:", err);
    req.flash("notification", "Failed to update SL binding");
    res.redirect(req.get("Referrer") || "/");
  }
});

router.post("/sl-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await SLBinding.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set SL binding "${binding._id}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("SL BINDING SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

router.post("/sl-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await SLBinding.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set SL binding "${binding._id}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("SL BINDING SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/sl-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");
    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter SL Specs (cascading smart form) */
router.get("/form/sl-binding/filter-specs", async (req, res) => {
  try {
    const query = req.query;

    const buildFilter = (excludeKey) => {
      const f = {};
      Object.entries(SPEC_FIELDS).forEach(([key, path]) => {
        if (query[key] && key !== excludeKey) f[path] = flex(query[key]);
      });
      return f;
    };

    const result = {};
    for (const [key, path] of Object.entries(SPEC_FIELDS)) {
      result[key] = await SachikoSL.distinct(path, buildFilter(key));
    }

    res.json(result);
  } catch (err) {
    console.error("SL FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve SL from Specifications */
router.get("/form/sl-binding/resolve-sl", async (req, res) => {
  try {
    const query = req.query;
    const filter = {};
    for (const [key, path] of Object.entries(SPEC_FIELDS)) {
      if (!query[key] && query[key] !== "0") return res.status(400).json(null);
      filter[path] = flex(query[key]);
    }

    const sl = await SachikoSL.findOne(filter).lean();
    if (!sl) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      slId: sl._id,
      productCode: sl.productCode,
      skuCode: sl.skuCode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

export default router;
