import express from "express";
import BoardPaper from "../../models/system/boardPaper.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const requireBoardPaperMaster = requireRole(["proprietor", "admin", "hod"]);

router.get("/form/board-paper", requireBoardPaperMaster, async (req, res) => {
  const boardPapers = await BoardPaper.find().sort({ boardPaperName: 1 }).lean();
  res.render("inventory/masters/boardPaperMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Board Paper Master",
    boardPapers,
    notification: req.flash("notification"),
  });
});

router.post("/form/board-paper", requireAuth, requireBoardPaperMaster, createLimiter, async (req, res) => {
  try {
    const boardPaperName = String(req.body.boardPaperName || "").trim().toUpperCase();
    if (!boardPaperName) return res.status(400).json({ success: false, message: "Board paper name is required." });

    const duplicate = await BoardPaper.exists({ boardPaperName });
    if (duplicate) return res.status(400).json({ success: false, message: "This board paper already exists." });

    await BoardPaper.create({ boardPaperName });

    res.locals.auditDescription = `Created board paper "${boardPaperName}"`;
    req.flash("notification", "Board paper created successfully!");
    res.json({ success: true, redirect: "/app/form/board-paper" });
  } catch (err) {
    console.error("BOARD PAPER MASTER CREATE ERROR:", err);
    // The unique index is the duplicate check, so a race that slips past the
    // exists() above still lands here rather than as a 500.
    const isDup = err.code === 11000;
    res.status(400).json({
      success: false,
      message: isDup ? "This board paper already exists." : "Failed to create board paper.",
    });
  }
});

router.put("/api/board-paper/:id", requireAuth, requireBoardPaperMaster, updateLimiter, async (req, res) => {
  try {
    const boardPaperName = String(req.body.boardPaperName || "").trim().toUpperCase();
    if (!boardPaperName) return res.status(400).json({ success: false, message: "Board paper name is required." });

    const duplicate = await BoardPaper.exists({ boardPaperName, _id: { $ne: req.params.id } });
    if (duplicate) return res.status(400).json({ success: false, message: "This board paper already exists." });

    const updated = await BoardPaper.findByIdAndUpdate(
      req.params.id,
      { boardPaperName },
      { new: true, runValidators: true },
    );
    if (!updated) return res.status(404).json({ success: false, message: "Board paper not found." });

    res.locals.auditDescription = `Updated board paper "${updated.boardPaperName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("BOARD PAPER MASTER UPDATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({
      success: false,
      message: isDup ? "This board paper already exists." : "Failed to update board paper.",
    });
  }
});

router.delete("/api/board-paper/:id", requireAuth, requireBoardPaperMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await BoardPaper.findByIdAndDelete(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Board paper not found." });
    res.locals.auditDescription = `Deleted board paper "${existing.boardPaperName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("BOARD PAPER MASTER DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete board paper." });
  }
});

export default router;
