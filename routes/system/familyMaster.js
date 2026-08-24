import express from "express";
import Family from "../../models/system/family.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const requireFamilyMaster = requireRole(["proprietor", "admin", "hod"]);

router.get("/form/family", requireFamilyMaster, async (req, res) => {
  const families = await Family.find().sort({ familyName: 1 }).lean();
  res.render("inventory/masters/familyMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Family Master",
    families,
    notification: req.flash("notification"),
  });
});

router.post("/form/family", requireAuth, requireFamilyMaster, createLimiter, async (req, res) => {
  try {
    const familyName = String(req.body.familyName || "").trim().toUpperCase();
    if (!familyName) return res.status(400).json({ success: false, message: "Family name is required." });

    const duplicate = await Family.exists({ familyName });
    if (duplicate) return res.status(400).json({ success: false, message: "This family already exists." });

    await Family.create({ familyName });

    res.locals.auditDescription = `Created family "${familyName}"`;
    req.flash("notification", "Family created successfully!");
    res.json({ success: true, redirect: "/sachiko/form/family" });
  } catch (err) {
    console.error("FAMILY MASTER CREATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({ success: false, message: isDup ? "This family already exists." : "Failed to create family." });
  }
});

router.put("/api/family/:id", requireAuth, requireFamilyMaster, updateLimiter, async (req, res) => {
  try {
    const familyName = String(req.body.familyName || "").trim().toUpperCase();
    if (!familyName) return res.status(400).json({ success: false, message: "Family name is required." });

    const duplicate = await Family.exists({ familyName, _id: { $ne: req.params.id } });
    if (duplicate) return res.status(400).json({ success: false, message: "This family already exists." });

    const updated = await Family.findByIdAndUpdate(req.params.id, { familyName }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: "Family not found." });

    res.locals.auditDescription = `Updated family "${updated.familyName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FAMILY MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({ success: false, message: isDup ? "This family already exists." : "Failed to update family." });
  }
});

router.delete("/api/family/:id", requireAuth, requireFamilyMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await Family.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Family not found." });
    res.locals.auditDescription = `Deleted family "${existing.familyName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("FAMILY MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete family." });
  }
});

export default router;
