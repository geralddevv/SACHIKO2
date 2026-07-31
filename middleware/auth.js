const wantsJson = (req) => req.xhr || req.headers.accept?.includes("application/json");

const OPERATOR_PORTAL_PREFIX = "/sachiko/operator";

// Operators have no staff account, so a missing/expired session on an
// operator page must never bounce them to the staff login.
function loginUrlFor(req) {
  if (req.session?.authUser?.role === "operator") return "/sachiko/operator/login";
  const path = String(req.originalUrl || "").split("?")[0];
  if (path.startsWith(OPERATOR_PORTAL_PREFIX)) return "/sachiko/operator/login";
  return "/sachiko/login";
}

export const requireAuth = (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect(loginUrlFor(req));
  }
  next();
};

export const requireRole = (roles) => (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect(loginUrlFor(req));
  }
  if (!roles.includes(req.session.authUser.role)) {
    if (wantsJson(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("errors/accessDenied", {
      title: "Access Denied",
      CSS: false,
      JS: false,
      roleLabel: String(req.session.authUser.role || "").toUpperCase(),
    });
  }
  next();
};
