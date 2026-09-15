const wantsJson = (req) => req.xhr || req.headers.accept?.includes("application/json");

const OPERATOR_PORTAL_PREFIX = "/app/operator";

// Operators have no staff account, so a missing/expired session on an
// operator page must never bounce them to the staff login.
function loginUrlFor(req) {
  if (req.session?.authUser?.role === "operator") return "/app/operator/login";
  const path = String(req.originalUrl || "").split("?")[0];
  if (path.startsWith(OPERATOR_PORTAL_PREFIX)) return "/app/operator/login";
  return "/app/login";
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
      // The page is built on the auth layout's card, whose styles live in
      // login.css -- without this it renders as bare unstyled text.
      CSS: "login.css",
      JS: false,
      roleLabel: String(req.session.authUser.role || "").toUpperCase(),
      // Shown so the user can tell their administrator exactly what to open
      // up. brandPrefix rewrites the /app prefix back to the company slug on
      // the way out, so this reads as the URL in their address bar.
      requestedPath: String(req.originalUrl || "").split("?")[0],
    });
  }
  next();
};
