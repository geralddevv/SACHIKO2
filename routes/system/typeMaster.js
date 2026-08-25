import express from "express";
import Type from "../../models/system/type.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const requireTypeMaster = requireRole(["proprietor", "admin", "hod"]);

router.get("/form/type", requireTypeMaster, async (req, res) => {
  const types = await Type.find().sort({ typeName: 1 }).lean();
  res.render("inventory/masters/typeMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Type Master",
    types,
    notification: req.flash("notification"),
  });
});

router.post("/form/type", requireAuth, requireTypeMaster, createLimiter, async (req, res) => {
  try {
    const typeName = String(req.body.typeName || "").trim().toUpperCase();
    if (!typeName) return res.status(400).json({ success: false, message: "Type name is required." });

    const duplicate = await Type.exists({ typeName });
    if (duplicate) return res.status(400).json({ success: false, message: "This type already exists." });

    await Type.create({ typeName });

    res.locals.auditDescription = `Created type "${typeName}"`;
    req.flash("notification", "Type created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/type" });
  } catch (err) {
    console.error("TYPE MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({ success: false, message: isDup ? "This type already exists." : "Failed to create type." });
  }
});

router.put("/api/type/:id", requireAuth, requireTypeMaster, updateLimiter, async (req, res) => {
  try {
    const typeName = String(req.body.typeName || "").trim().toUpperCase();
    if (!typeName) return res.status(400).json({ success: false, message: "Type name is required." });

    const duplicate = await Type.exists({ typeName, _id: { $ne: req.params.id } });
    if (duplicate) return res.status(400).json({ success: false, message: "This type already exists." });

    const updated = await Type.findByIdAndUpdate(req.params.id, { typeName }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: "Type not found." });

    res.locals.auditDescription = `Updated type "${updated.typeName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("TYPE MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({ success: false, message: isDup ? "This type already exists." : "Failed to update type." });
  }
});

router.delete("/api/type/:id", requireAuth, requireTypeMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await Type.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Type not found." });
    res.locals.auditDescription = `Deleted type "${existing.typeName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("TYPE MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete type." });
  }
});

export default router;
