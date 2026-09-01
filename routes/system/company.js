import express from "express";
import Company from "../../models/system/company.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter } from "../../utils/limiters.js";

const router = express.Router();

const requireCompanyMaster = requireRole(["proprietor", "admin", "hod"]);

// Only one company can exist, so there is no list and no delete -- the page
// either offers the blank registration form or the saved record for editing.
const REQUIRED_FIELDS = [
  ["companyName", "Company name"],
  ["address", "Address"],
  ["state", "State"],
  ["country", "Country"],
  ["pincode", "Pincode"],
  ["mobile", "Mobile"],
];

function readPayload(body) {
  const text = (v) => String(v || "").trim();
  return {
    companyName: text(body.companyName).toUpperCase(),
    address: text(body.address).toUpperCase(),
    state: text(body.state).toUpperCase(),
    country: text(body.country).toUpperCase(),
    pincode: text(body.pincode),
    telephone: text(body.telephone),
    mobile: text(body.mobile),
    email: text(body.email).toLowerCase(),
    website: text(body.website),
  };
}

function validate(payload) {
  for (const [field, label] of REQUIRED_FIELDS) {
    if (!payload[field]) return `${label} is required.`;
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return "Please enter a valid e-mail address.";
  }
  return null;
}

router.get("/form/company", requireCompanyMaster, async (req, res) => {
  const company = await Company.findOne({ singleton: "COMPANY" }).lean();
  res.render("inventory/masters/companyMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Company Registration",
    company,
    notification: req.flash("notification"),
  });
});

router.post("/form/company", requireAuth, requireCompanyMaster, createLimiter, async (req, res) => {
  try {
    const payload = readPayload(req.body);
    const problem = validate(payload);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const existing = await Company.exists({ singleton: "COMPANY" });
    if (existing) {
      return res.status(400).json({ success: false, message: "A company is already registered. Edit it instead." });
    }

    await Company.create({ ...payload, singleton: "COMPANY" });

    res.locals.auditDescription = `Registered company "${payload.companyName}"`;
    req.flash("notification", "Company registered successfully!");
    res.json({ success: true, redirect: "/sachiko/form/company" });
  } catch (err) {
    console.error("COMPANY REGISTRATION CREATE ERROR:", err);
    const isDup = err.code === 11000;
    res.status(400).json({
      success: false,
      message: isDup ? "A company is already registered. Edit it instead." : "Failed to register company.",
    });
  }
});

router.put("/api/company/:id", requireAuth, requireCompanyMaster, updateLimiter, async (req, res) => {
  try {
    const payload = readPayload(req.body);
    const problem = validate(payload);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const updated = await Company.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ success: false, message: "Company not found." });

    res.locals.auditDescription = `Updated company "${updated.companyName}"`;
    req.flash("notification", "Company details updated successfully!");
    res.json({ success: true, redirect: "/sachiko/form/company" });
  } catch (err) {
    console.error("COMPANY REGISTRATION UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update company." });
  }
});

export default router;
