import express from "express";
import Company from "../../models/system/company.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { refreshBrand, refreshBrandAfterSwitch, currentBrand } from "../../utils/companyBrand.js";
import { renameCompanyDb, currentDbName, makeCompanyDbId, isCompanyDbName } from "../../utils/companyDb.js";
import { mediaUpload, storeUploads, removeAssets, removeTempFiles } from "../../utils/media.js";

const router = express.Router();

const requireCompanyMaster = requireRole(["proprietor", "admin", "hod"]);

// Optional company logo -- a single image, compressed + thumbnailed by
// utils/media.js. Absent -> the app falls back to the first letter of the name
// (see /company/favicon in server.js).
const logoUpload = mediaUpload({ bucket: "company", fields: [{ name: "logo", kind: "image", maxCount: 1 }] });

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
  const bank = body.bankDetails && typeof body.bankDetails === "object" ? body.bankDetails : {};
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
    gst: text(body.gst).toUpperCase(),
    msme: text(body.msme).toUpperCase(),
    gumasta: text(body.gumasta).toUpperCase(),
    pan: text(body.pan).toUpperCase(),
    bankDetails: {
      bankName: text(bank.bankName).toUpperCase(),
      accountHolderName: text(bank.accountHolderName).toUpperCase(),
      accountNumber: text(bank.accountNumber),
      ifsc: text(bank.ifsc).toUpperCase(),
      branch: text(bank.branch).toUpperCase(),
    },
  };
}

// Same formats the client master enforces (routes/fairdesk_route.js).
const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function validate(payload) {
  for (const [field, label] of REQUIRED_FIELDS) {
    if (!payload[field]) return `${label} is required.`;
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return "Please enter a valid e-mail address.";
  }
  if (payload.gst && !GST_REGEX.test(payload.gst)) {
    return "Invalid GST number format.";
  }
  if (payload.pan && !PAN_REGEX.test(payload.pan)) {
    return "Invalid PAN number format.";
  }
  if (payload.gst && payload.pan && payload.gst.substring(2, 12) !== payload.pan) {
    return "PAN does not match GST number.";
  }
  if (payload.bankDetails.ifsc && !IFSC_REGEX.test(payload.bankDetails.ifsc)) {
    return "Invalid IFSC code format.";
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

    const created = await Company.create({ ...payload, singleton: "COMPANY" });

    // Move the company onto its own database under a stable random name (one
    // copy, once). From here on the database name is fixed -- renaming the
    // company only changes the URL slug, never the data.
    if (!isCompanyDbName(currentDbName())) {
      const r = await renameCompanyDb(makeCompanyDbId(), { companyId: created._id });
      if (r.error) {
        await Company.deleteOne({ singleton: "COMPANY" });
        return res.status(409).json({ success: false, message: r.error });
      }
      const brand = await refreshBrandAfterSwitch(payload.companyName);
      res.locals.auditDescription = `Registered company "${payload.companyName}" (database "${r.oldDb}" -> "${r.newDb}")`;
      return res.json({ success: true, reload: true, redirect: `/${brand.slug}/form/company` });
    }

    await refreshBrand(); // company name now drives the URL slug too
    res.locals.auditDescription = `Registered company "${payload.companyName}"`;
    req.flash("notification", "Company registered successfully!");
    res.json({ success: true, redirect: `/${currentBrand().slug}/form/company` });
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

    // The company name drives only the URL slug + display name. The database is
    // a fixed random id (assigned at registration) and is never touched here --
    // so a rename is instant, the session stays valid, and nothing is copied.
    await refreshBrand();
    res.locals.auditDescription = `Updated company "${updated.companyName}"`;
    req.flash("notification", "Company details updated successfully!");
    res.json({ success: true, redirect: `/${currentBrand().slug}/form/company` });
  } catch (err) {
    console.error("COMPANY REGISTRATION UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to update company." });
  }
});

// ---- Company logo (optional) --------------------------------------------------

router.post(
  "/api/company/:id/logo",
  requireAuth,
  requireCompanyMaster,
  updateLimiter,
  logoUpload,
  async (req, res) => {
    let stored = [];
    try {
      if (!req.files?.logo?.length) {
        return res.status(400).json({ success: false, message: "Choose an image to use as the logo." });
      }
      if (!(await Company.exists({ _id: req.params.id }))) {
        await removeTempFiles(req.files);
        return res.status(404).json({ success: false, message: "Company not found." });
      }

      stored = await storeUploads(req.files, "company"); // compresses + cleans temps
      // $set rather than doc.save() -- avoids re-validating the whole record.
      const previous = await Company.findByIdAndUpdate(
        req.params.id,
        { $set: { logo: stored[0] } },
        { new: false },
      );
      if (previous?.logo) await removeAssets(previous.logo);

      await refreshBrand();
      res.locals.auditDescription = "Updated the company logo";
      res.json({ success: true });
    } catch (err) {
      await removeAssets(stored);
      await removeTempFiles(req.files);
      console.error("COMPANY LOGO UPLOAD ERROR:", err);
      res.status(400).json({ success: false, message: err.message || "Could not save the logo." });
    }
  },
);

router.delete(
  "/api/company/:id/logo",
  requireAuth,
  requireCompanyMaster,
  deleteLimiter,
  async (req, res) => {
    try {
      // $unset rather than `company.logo = null; save()` -- assigning null to a
      // single nested subdoc path is unreliable across mongoose versions.
      const company = await Company.findByIdAndUpdate(
        req.params.id,
        { $unset: { logo: 1 } },
        { new: false },
      );
      if (!company) return res.status(404).json({ success: false, message: "Company not found." });
      if (company.logo) await removeAssets(company.logo);

      await refreshBrand();
      res.locals.auditDescription = "Removed the company logo";
      res.json({ success: true });
    } catch (err) {
      console.error("COMPANY LOGO DELETE ERROR:", err);
      res.status(400).json({ success: false, message: "Could not remove the logo." });
    }
  },
);

export default router;
