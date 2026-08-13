import express from "express";
import mongoose from "mongoose";
import path from "path";
import MaintenanceRequest, { MAINTENANCE_STATUSES } from "../../models/system/maintenanceRequest.js";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import Counter from "../../models/system/counter.js";
import { requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";
import {
  mediaUpload,
  storeUploads,
  removeAssets,
  removeTempFiles,
  sendAsset,
  formatBytes,
  formatDuration,
} from "../../utils/media.js";

const router = express.Router();

/*
 * Shopfloor maintenance tickets.
 *
 * Operators raise them from their own portal (photo of the problem + a
 * description) and watch the status on the same page; management sees every
 * ticket on /sachiko/maintenance and moves it along with a remark. Mounted on
 * the bare "/sachiko" prefix with no role gate at the mount (see server.js),
 * so every route below carries its own.
 */

const requireOperator = requireRole(["operator"]);
// Who can see the shopfloor's tickets: everyone with a staff login.
const requireStaff = requireRole(["proprietor", "admin", "hod", "sales", "hr"]);
// Who can act on them -- same management set that owns the machine master.
const requireMaintenanceAction = requireRole(["proprietor", "admin", "hod"]);

/* ================= ATTACHMENTS ================= */
// A photo and/or a video of the problem, both optional individually but at
// least one required. Compression, thumbnails and cleanup all live in
// utils/media.js -- this route only decides what it accepts.
const MAINTENANCE_BUCKET = "maintenance";

const uploadMedia = mediaUpload({
  bucket: MAINTENANCE_BUCKET,
  fields: [
    { name: "photo", kind: "image", maxCount: 1 },
    { name: "video", kind: "video", maxCount: 1 },
  ],
});
// Re-exported for the operator JSON API, whose POST /maintenance accepts the
// same multipart photo field this web form does.
export { uploadMedia as maintenanceUpload };

/* ================= HELPERS ================= */

// Sequential ticket number, same `SP | <CODE> | 000001` shape used elsewhere
// in this app (see generateId in routes/system/machine.js).
async function generateTicketNo() {
  const counter = await Counter.findOneAndUpdate(
    { key: "maintenanceRequest" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | MNT | ${String(counter.seq).padStart(6, "0")}`;
}

// An operator's empProfileCode is the name of the machine they run (the same
// link the machine queue and Assign Production use), and machine names repeat
// across units -- so the location has to match too.
export async function resolveOperatorMachine(authUser) {
  const code = String(authUser?.profileCode || "").trim().toUpperCase();
  const locationName = normalizeLocationName(authUser?.empLoc);
  if (!code) return { machineId: null, machineName: "", locationName };

  const machines = await Machine.find({ machineName: code }).populate("location").lean();
  const machine =
    machines.find((m) => normalizeLocationName(m.location?.locationName) === locationName) ||
    (machines.length === 1 ? machines[0] : null);

  return {
    machineId: machine?._id || null,
    machineName: machine?.machineName || code,
    locationName: normalizeLocationName(machine?.location?.locationName) || locationName,
  };
}

// Every machine at one location, for the "Machine" picker on the report
// dialog -- an operator's own machine is the default (see resolveOperatorMachine
// above), but the problem might be on a neighbouring machine at the same
// unit, and this is what lets them say so without walking over and logging
// in there instead.
export async function listMachinesAtLocation(locationName) {
  if (!locationName) return [];
  const locationDoc = await Location.findOne({ locationName }).select("_id").lean();
  if (!locationDoc) return [];
  return Machine.find({ location: locationDoc._id }).sort({ machineName: 1 }).select("machineName").lean();
}

// Attachments as the views want them: a stable index (that's how they're
// fetched back), what kind they are, and a readable size/length. Tickets raised
// before the shared media store existed carry a bare `photo` filename instead
// of a media[] entry, so they're folded in here rather than special-cased in
// two templates.
const toMedia = (doc) => {
  const assets = Array.isArray(doc.media) && doc.media.length
    ? doc.media
    : doc.photo
      ? [{ kind: "image", bucket: MAINTENANCE_BUCKET, filename: doc.photo, mimeType: "image/jpeg" }]
      : [];

  return assets.map((asset, index) => ({
    index,
    kind: asset.kind,
    label: asset.kind === "video" ? "Video" : "Photo",
    sizeLabel: asset.size ? formatBytes(asset.size) : "",
    durationLabel: asset.durationSec ? formatDuration(asset.durationSec) : "",
    // Both URLs are index-based: the filename never reaches the browser.
    url: `/sachiko/maintenance/media/${doc._id}/${index}`,
    thumbUrl: `/sachiko/maintenance/media/${doc._id}/${index}/thumb`,
  }));
};

// Shape one document for the views (both lists render the same card/row data)
// and, verbatim, for the mobile app's JSON responses.
export const toMaintenanceRow = (doc) => ({
  _id: String(doc._id),
  ticketNo: doc.ticketNo,
  machineName: doc.machineName || "—",
  locationName: doc.locationName || "—",
  description: doc.description || "",
  media: toMedia(doc),
  raisedByName: doc.raisedByName || "—",
  raisedByProfileCode: doc.raisedByProfileCode || "",
  status: doc.status,
  createdAt: doc.createdAt,
  actions: (doc.actions || []).map((a) => ({
    status: a.status,
    remark: a.remark || "",
    byName: a.byName || "",
    byRole: a.byRole || "",
    at: a.at,
  })),
  // The last thing anyone said about it -- what the operator most wants to see.
  latestAction: (doc.actions || []).length ? doc.actions[doc.actions.length - 1] : null,
});

// Thrown when a submitted ticket fails validation (empty/too-long
// description). Carries the HTTP status both callers should surface, so the web
// form and the JSON API return the same message for the same bad input.
export class MaintenanceInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "MaintenanceInputError";
    this.statusCode = statusCode;
  }
}

// Create one operator ticket from a raw request: a required description, an
// optional photo/video (already parsed onto `files` by maintenanceUpload), and
// an optional requested machine id. Shared verbatim by the web portal's form
// and the mobile app's JSON endpoint so both write identical tickets. Owns the
// upload lifecycle -- on any failure it removes the temp/compressed files it
// touched before rethrowing, leaving nothing orphaned. Returns the saved doc
// plus the bits the callers need for their audit line.
export async function createOperatorTicket({ authUser, description, requestedMachineId, files }) {
  const desc = String(description || "").trim();
  if (!desc) {
    await removeTempFiles(files);
    throw new MaintenanceInputError("Please describe the problem.");
  }
  if (desc.length > 1000) {
    await removeTempFiles(files);
    throw new MaintenanceInputError("Description is too long (max 1000 characters).");
  }
  // A photo/video is not required -- a description alone is still a useful
  // ticket, and not every problem is something a camera helps with.

  let stored = [];
  try {
    // Compresses both files and cleans up the raw uploads; throws (having
    // removed anything it already wrote) if either one can't be processed.
    stored = await storeUploads(files, MAINTENANCE_BUCKET);

    let { machineId, machineName, locationName } = await resolveOperatorMachine(authUser);
    // The picker only ever lists machines at the operator's own location (see
    // listMachinesAtLocation), so a requested id is only honoured if it
    // actually resolves to one of those -- a stale or tampered id is ignored
    // and the ticket still goes in against the operator's own machine rather
    // than failing outright.
    const reqMachineId = String(requestedMachineId || "").trim();
    if (reqMachineId && mongoose.isValidObjectId(reqMachineId)) {
      const requestedMachine = await Machine.findById(reqMachineId).populate("location").lean();
      if (requestedMachine && normalizeLocationName(requestedMachine.location?.locationName) === locationName) {
        machineId = requestedMachine._id;
        machineName = requestedMachine.machineName;
      }
    }

    const ticketNo = await generateTicketNo();
    const ticket = await MaintenanceRequest.create({
      ticketNo,
      machineId,
      machineName,
      locationName,
      description: desc,
      media: stored,
      raisedById: mongoose.isValidObjectId(authUser?.empObjId) ? authUser.empObjId : null,
      raisedByEmpId: authUser?.empId || "",
      raisedByName: authUser?.empName || authUser?.username || "",
      raisedByProfileCode: authUser?.profileCode || "",
      status: "OPEN",
    });

    return { ticket, stored, ticketNo, machineName };
  } catch (err) {
    // The ticket never got written, so the compressed files would be orphans.
    await removeAssets(stored);
    await removeTempFiles(files);
    throw err;
  }
}

/* ================= OPERATOR SIDE ================= */

// The operator's Maintenance tab: their own tickets, newest first, plus the
// dialog that raises a new one.
router.get("/operator/maintenance", requireOperator, async (req, res) => {
  const authUser = req.session?.authUser;
  const operatorObjId = authUser?.empObjId;

  const docs =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.find({ raisedById: operatorObjId }).sort({ createdAt: -1 }).lean()
      : [];

  const { machineId, machineName, locationName } = await resolveOperatorMachine(authUser);
  const machines = await listMachinesAtLocation(locationName);

  res.render("system/operatorMaintenance.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Maintenance",
    operatorName: authUser?.empName || "",
    operatorLocation: authUser?.empLoc || "",
    machineName,
    locationName,
    machines: machines.map((m) => ({ _id: String(m._id), machineName: m.machineName })),
    defaultMachineId: machineId ? String(machineId) : "",
    requests: docs.map(toMaintenanceRow),
    openCount: docs.filter((d) => d.status === "OPEN" || d.status === "IN PROGRESS").length,
    notification: req.flash("notification"),
  });
});

router.post("/operator/maintenance", requireOperator, createLimiter, uploadMedia, async (req, res) => {
  try {
    const { stored, ticketNo, machineName } = await createOperatorTicket({
      authUser: req.session?.authUser,
      description: req.body.description,
      requestedMachineId: req.body.machineId,
      files: req.files,
    });

    const what = stored.map((a) => a.kind).join(" + ") || "no attachment";
    res.locals.auditDescription = `Raised maintenance ticket "${ticketNo}" for machine "${machineName || "—"}" (${what})`;
    req.flash("notification", `Issue reported — ticket ${ticketNo}`);
    res.json({ success: true, redirect: "/sachiko/operator/maintenance" });
  } catch (err) {
    if (!(err instanceof MaintenanceInputError)) console.error("MAINTENANCE CREATE ERROR:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message || "Could not report the issue." });
  }
});

/* ================= STAFF SIDE ================= */

// Every ticket, newest first, optionally narrowed to one status by ?status=.
router.get("/maintenance", requireStaff, async (req, res) => {
  const statusFilter = String(req.query.status || "").trim().toUpperCase();
  const filter = MAINTENANCE_STATUSES.includes(statusFilter) ? { status: statusFilter } : {};

  const [docs, counts] = await Promise.all([
    MaintenanceRequest.find(filter).sort({ createdAt: -1 }).limit(500).lean(),
    MaintenanceRequest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  const countByStatus = Object.fromEntries(counts.map((c) => [c._id, c.count]));

  res.render("system/maintenanceRequests.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Maintenance Requests",
    requests: docs.map(toMaintenanceRow),
    statuses: MAINTENANCE_STATUSES,
    activeStatus: MAINTENANCE_STATUSES.includes(statusFilter) ? statusFilter : "",
    countByStatus,
    totalCount: Object.values(countByStatus).reduce((a, b) => a + b, 0),
    canAct: ["proprietor", "admin", "hod"].includes(req.session?.authUser?.role),
    notification: req.flash("notification"),
  });
});

// Move a ticket along: the new status plus an optional remark, appended to the
// action trail so the operator can read what was done at each step.
router.put("/maintenance/:id/status", requireMaintenanceAction, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    const status = String(req.body.status || "").trim().toUpperCase();
    if (!MAINTENANCE_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Please choose a valid status." });
    }

    const remark = String(req.body.remark || "").trim().slice(0, 500);
    const ticket = await MaintenanceRequest.findById(id);
    if (!ticket) return res.status(404).json({ success: false, message: "Request not found" });

    const authUser = req.session?.authUser;
    ticket.status = status;
    ticket.actions.push({
      status,
      remark,
      byName: authUser?.empName || authUser?.username || "",
      byRole: authUser?.role || "",
      at: new Date(),
    });
    ticket.closedAt = status === "RESOLVED" || status === "REJECTED" ? new Date() : null;
    await ticket.save();

    res.locals.auditDescription = `Set maintenance ticket "${ticket.ticketNo}" to ${status}`;
    req.flash("notification", `Ticket ${ticket.ticketNo} marked ${status}`);
    res.json({ success: true, redirect: "/sachiko/maintenance" });
  } catch (err) {
    console.error("MAINTENANCE STATUS ERROR:", err);
    res.status(400).json({ success: false, message: err.message || "Could not update the request." });
  }
});

/* ================= ATTACHMENTS ================= */

// Serve one ticket attachment (or its thumbnail) by ticket id + position, after
// checking the viewer may see it: any staff member, or the operator who raised
// it. `viewer` is { role, empObjId } -- sourced from the session on the web and
// from the bearer token on the JSON API, so both entry points enforce the same
// "own tickets only" rule. Attachments are addressed by position, never by
// filename: nothing is guessable, and an operator only ever reaches their own.
// Returns the asset itself, or its thumbnail when `thumb` is set -- videos
// stream with Range support, so they seek and start playing at once.
export async function serveMaintenanceAsset(res, { id, index, thumb = false, viewer }) {
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).send("Invalid request");

    const ticket = await MaintenanceRequest.findById(id).select("media photo raisedById").lean();
    if (!ticket) return res.status(404).send("Not found");

    const isStaff = ["proprietor", "admin", "hod", "coordinator", "sales", "hr"].includes(viewer?.role);
    const isOwner = viewer?.role === "operator" && String(ticket.raisedById || "") === String(viewer?.empObjId || "");
    if (!isStaff && !isOwner) return res.status(403).send("Forbidden");

    // Legacy tickets kept a bare filename under the old images/maintenance
    // folder; they're served from there so old photos keep working.
    const assets =
      Array.isArray(ticket.media) && ticket.media.length
        ? ticket.media
        : ticket.photo
          ? [{ kind: "image", bucket: "", filename: ticket.photo, mimeType: "image/jpeg" }]
          : [];

    const asset = assets[Number(index)];
    if (!asset) return res.status(404).send("Not found");

    if (!asset.bucket) {
      const legacyPath = path.join(process.cwd(), "images", "maintenance", path.basename(asset.filename));
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.sendFile(legacyPath, (err) => {
        if (err && !res.headersSent) res.status(404).send("Not found");
      });
    }

    return sendAsset(res, asset, { thumb });
  } catch (err) {
    console.error("MAINTENANCE MEDIA SERVE ERROR:", err);
    res.status(500).send("Failed to serve attachment");
  }
}

// The web routes serve attachments with the viewer taken from the session.
const serveAttachment = (thumb) => (req, res) => serveMaintenanceAsset(res, {
  id: req.params.id,
  index: req.params.index,
  thumb,
  viewer: { role: req.session?.authUser?.role, empObjId: req.session?.authUser?.empObjId },
});

router.get("/maintenance/media/:id/:index", serveAttachment(false));
router.get("/maintenance/media/:id/:index/thumb", serveAttachment(true));

// Back-compat with the first version of this page, which linked photos as
// /maintenance/photo/:id.
router.get("/maintenance/photo/:id", (req, res, next) => {
  req.params.index = "0";
  return serveAttachment(false)(req, res, next);
});

export default router;
