import Company from "../models/system/company.js";

// Everything the app shows / routes under, derived from the single Company
// master record (routes/system/company.js):
//   - name : the display name  (<title>, nav header, login screen)
//   - slug : the URL prefix    (/<slug>/...  in the address bar)
// Registering or renaming the company changes both, app-wide, with no restart:
// middleware/brandPrefix.js maps the live slug onto the fixed internal mount
// (INTERNAL_PREFIX) that every route is really registered under.

// The constant path every route is mounted at internally. The public slug is
// mapped onto this; when no company is registered yet the two are the same, so
// the app just works at /acme/... until then.
export const INTERNAL_PREFIX = "acme";

// Until a Company is saved: APP_BRAND_NAME from .env (set by scripts/rebrand.js),
// then the historical name.
const DEFAULT_BRAND = (process.env.APP_BRAND_NAME || "Sachiko Packaging").trim();

// Safety net only -- every company write calls invalidateCompanyBrand().
const TTL_MS = 5 * 60 * 1000;

// "SACHIKO PACKAGING" -> "Sachiko Packaging". Names are stored uppercase
// (models/system/company.js); the header/title/login have always shown them
// title-cased.
function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// Slugs that would collide with a real top-level path (static mounts, auth
// endpoints, the internal prefix itself).
const RESERVED_SLUGS = new Set([
  INTERNAL_PREFIX, "js", "css", "assets", "images", "media", "bootstrap",
  "login", "logout", "favicon", "check-session", "debug-image", "api",
  "fairtech", "fairdesk",
]);

// First word of the company name, reduced to URL-safe characters:
// "SACHIKO PACKAGING" -> "sachiko", "ACME LABELS PVT LTD" -> "acme". Anything
// that doesn't yield a usable, non-reserved slug falls back to the internal
// prefix so links keep working.
export function slugifyCompany(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const s = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z][a-z0-9]{0,30}$/.test(s) || RESERVED_SLUGS.has(s)) return INTERNAL_PREFIX;
  return s;
}

let cache = { name: DEFAULT_BRAND, slug: INTERNAL_PREFIX, logo: null, ver: "0", loadedAt: 0 };
let refreshing = null;

// Version token that changes whenever the logo or the record does -- used to
// bust the favicon cache (server.js /company/favicon, boilerplate <link>).
function verOf(doc) {
  return doc?.logo?.filename || (doc?.updatedAt ? String(new Date(doc.updatedAt).getTime()) : "0");
}

function setCache(rawName, logo, ver) {
  const raw = String(rawName || "");
  cache = {
    name: raw ? titleCase(raw) : DEFAULT_BRAND,
    slug: raw ? slugifyCompany(raw) : INTERNAL_PREFIX,
    logo: logo && logo.filename ? logo : null,
    ver: ver || "0",
    loadedAt: Date.now(),
  };
  return currentBrand();
}

// Synchronous read for the request hot path.
export function currentBrand() {
  return { name: cache.name, slug: cache.slug, logo: cache.logo, ver: cache.ver };
}

// Set the cache straight from a known company name -- used right after a
// database switch, where re-querying can race the fresh connection.
export function applyBrandName(rawName, opts = {}) {
  return setCache(rawName, opts.logo || null, opts.ver || String(Date.now()));
}

// After a DB switch: read the company from the new connection (retrying while it
// settles). If the new DB already had its own company that name wins; otherwise
// fall back to the name we just seeded / typed.
export async function refreshBrandAfterSwitch(fallbackName, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const doc = await Company.findOne({ singleton: "COMPANY" }).select("companyName logo updatedAt").lean();
      if (doc?.companyName) return setCache(doc.companyName, doc.logo, verOf(doc));
      if (fallbackName) return applyBrandName(fallbackName);
    } catch {
      /* connection still settling */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return applyBrandName(fallbackName);
}

export async function refreshBrand() {
  try {
    const doc = await Company.findOne({ singleton: "COMPANY" }).select("companyName logo updatedAt").lean();
    setCache(doc?.companyName, doc?.logo, verOf(doc));
  } catch (err) {
    console.error("COMPANY BRAND LOOKUP ERROR:", err);
    // leave any previously-loaded value in place; keep retrying if never loaded
    if (!cache.loadedAt) cache = { name: DEFAULT_BRAND, slug: INTERNAL_PREFIX, logo: null, ver: "0", loadedAt: 0 };
  }
  return currentBrand();
}

// Non-blocking: kick off a refresh if the cache is stale, but never make the
// caller wait for it.
export function ensureFreshBrand() {
  if (!refreshing && Date.now() - cache.loadedAt > TTL_MS) {
    refreshing = refreshBrand().finally(() => { refreshing = null; });
  }
}

export function invalidateCompanyBrand() {
  cache.loadedAt = 0;
  ensureFreshBrand();
}

// First word of the display name -- used where space is tight ("Sachiko - Page").
export function shortBrand(name) {
  return String(name || DEFAULT_BRAND).trim().split(/\s+/)[0] || DEFAULT_BRAND;
}
