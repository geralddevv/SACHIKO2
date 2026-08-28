import jwt from "jsonwebtoken";
import crypto from "crypto";

/*
 * Bearer-token auth for the mobile operator app. The rest of this codebase is
 * entirely cookie/session based (express-session + a Mongo session store),
 * which doesn't translate to a native client -- there's no browser cookie jar
 * and every mutating route is guarded by CSRF tokens tied to a session, which
 * a stateless mobile client has no natural way to carry. Bearer tokens sidestep
 * both problems: nothing ambient is sent automatically, so CSRF doesn't apply,
 * and there's no session to keep alive.
 *
 * Deliberately signed with a key *derived* from SESSION_SECRET rather than the
 * raw secret itself -- reusing one HMAC key across two different signing
 * purposes (cookie-signing vs JWT-signing) means a leak of either compromises
 * both, and neither can be rotated independently. Domain-separating via HMAC
 * gets a distinct key with zero new required env var.
 */
const deriveApiJwtSecret = () => {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be set to derive the operator API JWT secret.");
  }
  return crypto.createHmac("sha256", sessionSecret).update("operator-jwt-v1").digest();
};

const API_JWT_SECRET = deriveApiJwtSecret();
const API_JWT_TTL = "12h"; // shift-length TTL; expiry just means re-login, same spirit as the web session's rolling 30min TTL

// authUser here mirrors the shape stored in req.session.authUser on the web
// side (see utils/operatorAuth.js) so every downstream read (buildQueueRows,
// audit logging, rate-limit keying, ...) can treat req.authUser the same way.
export function signOperatorApiToken(authUser) {
  return jwt.sign(
    {
      username: authUser.username,
      empName: authUser.empName,
      empNickName: authUser.empNickName,
      profileCode: authUser.profileCode,
      role: authUser.role,
      permissions: authUser.permissions,
      empId: authUser.empId,
      empObjId: authUser.empObjId,
      empPhoto: authUser.empPhoto,
      empLoc: authUser.empLoc,
    },
    API_JWT_SECRET,
    { expiresIn: API_JWT_TTL },
  );
}

// Verify a raw operator token and hand back its payload. Throws with a `.code`
// of "FORBIDDEN" for a valid token whose role isn't operator, or a plain jwt
// error for anything unverifiable/expired -- callers map those to 403 vs 401.
function verifyOperatorToken(token) {
  const payload = jwt.verify(token, API_JWT_SECRET);
  if (payload.role !== "operator") {
    const err = new Error("Forbidden");
    err.code = "FORBIDDEN";
    throw err;
  }
  return payload;
}

function applyAuth(req, res, next, token) {
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // Kept separate from req.session.authUser (never written there) so a
    // bearer-authenticated request can't be mistaken for a session-authenticated
    // one anywhere else in the app.
    req.authUser = verifyOperatorToken(token);
    next();
  } catch (err) {
    if (err.code === "FORBIDDEN") return res.status(403).json({ error: "Forbidden" });
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireOperatorApiAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  return applyAuth(req, res, next, scheme === "Bearer" && token ? token : "");
}

// Media/asset GETs only. React Native's <Image> can't reliably attach an
// Authorization header on Android, so these read the same operator token from a
// `?token=` query param as a fallback when no Bearer header is present. Kept
// deliberately off requireOperatorApiAuth: a token in a query string can end up
// in access logs, so only read-only asset routes opt into it -- never a login
// or a mutating endpoint.
export function requireOperatorApiMediaAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, headerToken] = header.split(" ");
  const token = scheme === "Bearer" && headerToken ? headerToken : String(req.query.token || "");
  return applyAuth(req, res, next, token);
}
