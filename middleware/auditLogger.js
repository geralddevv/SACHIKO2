import AuditLog from "../models/system/auditLog.js";

/*
 * Records who did what: every mutating request (POST/PUT/PATCH/DELETE) made
 * by a logged-in user gets one AuditLog entry, written fire-and-forget on
 * res.on("finish") so it never adds latency to the actual response and a
 * logging failure can never break the real request.
 *
 * Deliberately does NOT log GET requests (page views) — at this app's route
 * count that would be extremely high volume for very little audit value.
 * LOGIN/LOGOUT are logged explicitly at their own call sites in server.js
 * instead of here, since req.session.authUser isn't in a meaningful state
 * around those requests.
 *
 * Description (the human-readable "what happened") is resolved in three
 * tiers, richest first:
 *   1. res.locals.auditDescription — set by the route handler itself, which
 *      has full context (e.g. `Created client "NAYASA SUPERPLAST"`, or for
 *      deletes, the entity's name looked up *before* it was removed).
 *   2. A generic guess from a small allowlist of common identifying body
 *      fields (clientName, productId, poNumber, ...) — covers routes that
 *      haven't been individually instrumented yet.
 *   3. Bare "<ACTION> <path>" — last-resort fallback.
 * Only the allowlisted fields below are ever read from req.body; nothing
 * else (so passwords/tokens/free-text fields never end up in the log).
 */

const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP_PATHS = new Set(["/fairtech/login", "/logout"]);

const ACTION_BY_METHOD = {
  POST: "CREATE",
  PUT: "UPDATE",
  PATCH: "UPDATE",
  DELETE: "DELETE",
};

const VERB_BY_ACTION = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
};

const GENERIC_NAME_FIELDS = [
  "clientName",
  "userName",
  "vendorName",
  "empName",
  "machineName",
  "jobName",
  "poNumber",
  "blockNo",
  "dieDieNo",
  "locationName",
  "companyName",
  "tapeClientPaperCode",
  "ttrClientMaterialCode",
  "posClientPaperCode",
  "tafetaClientMaterialCode",
  "vendorTapePaperCode",
  "vendorTtrMaterialCode",
  "vendorPosPaperCode",
  "vendorTafetaMaterialCode",
];

// Replace ObjectId-looking path segments with :id so similar routes group together.
function normalizePath(path) {
  return String(path || "")
    .split("/")
    .map((seg) => (/^[0-9a-fA-F]{24}$/.test(seg) ? ":id" : seg))
    .join("/");
}

function guessDescription(req, action, path) {
  const verb = VERB_BY_ACTION[action] || action;
  for (const field of GENERIC_NAME_FIELDS) {
    const val = req.body?.[field];
    if (typeof val === "string" && val.trim()) {
      return `${verb} "${val.trim()}"`;
    }
  }
  return `${verb} ${path}`;
}

export function auditLogger(req, res, next) {
  res.on("finish", () => {
    try {
      const authUser = req.session?.authUser;
      if (!authUser) return;
      if (!AUDITED_METHODS.has(req.method)) return;
      if (SKIP_PATHS.has(req.path)) return;

      const action = ACTION_BY_METHOD[req.method] || req.method;
      const path = normalizePath(req.originalUrl?.split("?")[0] || req.path);
      const description = res.locals.auditDescription || guessDescription(req, action, path);

      AuditLog.create({
        username: authUser.username,
        empName: authUser.empName,
        profileCode: authUser.profileCode,
        role: authUser.role,
        action,
        method: req.method,
        path,
        description,
        statusCode: res.statusCode,
        ip: req.ip,
      }).catch((err) => console.error("Audit log write failed:", err));
    } catch (err) {
      console.error("Audit log middleware error:", err);
    }
  });
  next();
}

export async function logAuthEvent(authUser, action, req) {
  try {
    await AuditLog.create({
      username: authUser?.username,
      empName: authUser?.empName,
      profileCode: authUser?.profileCode,
      role: authUser?.role,
      action,
      method: req.method,
      path: req.path,
      description: action === "LOGIN" ? `Logged in as "${authUser?.empName || authUser?.username}"` : `Logged out "${authUser?.empName || authUser?.username}"`,
      statusCode: 200,
      ip: req.ip,
    });
  } catch (err) {
    console.error("Audit log auth-event write failed:", err);
  }
}
