const wantsJson = (req) => req.xhr || req.headers.accept?.includes("application/json");

export const requireAuth = (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/sachiko/login");
  }
  next();
};

export const requireRole = (roles) => (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/sachiko/login");
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
