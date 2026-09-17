import Company from "../models/system/company.js";
import AuditLog from "../models/system/auditLog.js";

// Everything the app shows / routes under, derived from the single Company
// master record (routes/system/company.js):
//   - name     : the display name  (<title>, nav header, login screen)
//   - slug     : the URL prefix    (/<slug>/...  in the address bar)
//   - idPrefix : the code every generated id starts with
//                ("SP | FCS | 000001", "SP | LOT | 0042")
// Registering or renaming the company changes both, app-wide, with no restart:
// middleware/brandPrefix.js maps the live slug onto the fixed internal mount
// (INTERNAL_PREFIX) that every route is really registered under.

// The constant path every route is mounted at internally. The public slug is
// mapped onto this; when no company is registered yet the two are the same, so
// the app just works at /app/... until then.
export const INTERNAL_PREFIX = "app";

// Until a Company is saved: APP_BRAND_NAME from .env (set by scripts/rebrand.js),
// then the historical name.
const DEFAULT_BRAND = (process.env.APP_BRAND_NAME || "Sachiko Packaging").trim();

// The id code used until a Company is saved -- the one this app has always
// minted, so an existing database's numbering is unchanged by any of this.
const DEFAULT_ID_PREFIX = "SP";

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

// What the id code would be if nobody typed one: the initials of the company's
// words, or the first two letters of a one-word name.
//   "SACHIKO PACKAGING" -> SP     "ACME LABELS PVT LTD" -> AL
//   "ZACTAC"            -> ZA     "3M INDIA"            -> 3I
// It is only ever a SUGGESTION. The Company master carries the real code
// (companySchema.idPrefix), because a company's own short code is a business
// fact, not something a rule can be trusted to guess -- Zactac call themselves
// ZC, which no derivation from the letters would produce.
export function suggestIdPrefix(name) {
  const words = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return DEFAULT_ID_PREFIX;
  const code = words.length > 1
    ? words.slice(0, 2).map((w) => w[0]).join("")
    : words[0].slice(0, 2);
  return isIdPrefix(code) ? code : DEFAULT_ID_PREFIX;
}

// What may be typed into the field: 2-4 letters/digits. Kept short because it
// sits in front of every id on every screen, label and job card.
export function isIdPrefix(value) {
  return /^[A-Z0-9]{2,4}$/.test(String(value || "").trim().toUpperCase());
}

let cache = { name: DEFAULT_BRAND, slug: INTERNAL_PREFIX, idPrefix: DEFAULT_ID_PREFIX, pastSlugs: [], logo: null, ver: "0", loadedAt: 0 };
let refreshing = null;

// Version token that changes whenever the logo or the record does -- used to
// bust the favicon cache (server.js /company/favicon, boilerplate <link>).
function verOf(doc) {
  return doc?.logo?.filename || (doc?.updatedAt ? String(new Date(doc.updatedAt).getTime()) : "0");
}

function setCache(rawName, logo, ver, idPrefix, slugHistory) {
  const raw = String(rawName || "");
  const typed = String(idPrefix || "").trim().toUpperCase();
  cache = {
    name: raw ? titleCase(raw) : DEFAULT_BRAND,
    slug: raw ? slugifyCompany(raw) : INTERNAL_PREFIX,
    // The typed code wins; failing that the name's own initials; failing that
    // the historical default.
    idPrefix: isIdPrefix(typed) ? typed : (raw ? suggestIdPrefix(raw) : DEFAULT_ID_PREFIX),
    // Prefixes this company used to be served under -- never the current one,
    // never the internal mount.
    pastSlugs: (Array.isArray(slugHistory) ? slugHistory : [])
      .map((x) => String(x || "").trim().toLowerCase())
      .filter((x) => x && x !== INTERNAL_PREFIX),
    logo: logo && logo.filename ? logo : null,
    ver: ver || "0",
    loadedAt: Date.now(),
  };
  return currentBrand();
}

// Synchronous read for the request hot path.
export function currentBrand() {
  return { name: cache.name, slug: cache.slug, idPrefix: cache.idPrefix, logo: cache.logo, ver: cache.ver };
}

// The URL prefixes this company has been served under before -- what
// brandPrefix.js forwards to the current one so a rename doesn't 404 every
// bookmark and open tab.
export function pastSlugs() {
  const { slug } = cache;
  return (cache.pastSlugs || []).filter((x) => x !== slug);
}

// The code every newly generated id starts with. Read at mint time, never
// stored anywhere else, so renaming the company changes the ids minted from
// then on with no restart -- and leaves every id already in the database
// exactly as it is (an id is an opaque string here; nothing parses it back).
export function currentIdPrefix() {
  return cache.idPrefix || DEFAULT_ID_PREFIX;
}

// Set the cache straight from a known company name -- used right after a
// database switch, where re-querying can race the fresh connection.
export function applyBrandName(rawName, opts = {}) {
  return setCache(rawName, opts.logo || null, opts.ver || String(Date.now()), opts.idPrefix, opts.slugHistory);
}

// After a DB switch: read the company from the new connection (retrying while it
// settles). If the new DB already had its own company that name wins; otherwise
// fall back to the name we just seeded / typed.
export async function refreshBrandAfterSwitch(fallbackName, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const doc = await Company.findOne({ singleton: "COMPANY" }).select("companyName idPrefix slugHistory logo updatedAt").lean();
      if (doc?.companyName) return setCache(doc.companyName, doc.logo, verOf(doc), doc.idPrefix, doc.slugHistory);
      if (fallbackName) return applyBrandName(fallbackName);
    } catch {
      /* connection still settling */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return applyBrandName(fallbackName);
}

// Every name this company has been saved under, oldest first, read out of the
// audit log ("Registered company \"X\"" / "Updated company \"X\"" -- written by
// middleware/auditLogger.js on every company write since the beginning).
//
// This is what makes an old address keep working with no step for anyone to
// remember: a company renamed before slugHistory existed has no record of the
// prefix it used to be served under, and the audit log has known all along.
// Run once per database -- the result is written back, so the regex scan
// happens on one boot and never again.
async function seedSlugHistory(company) {
  const entries = await AuditLog.find({ description: /^(Registered|Updated) company "/ })
    .select("description")
    .sort({ createdAt: 1 })
    .lean();

  const currentSlug = slugifyCompany(company.companyName);
  const seen = [];
  for (const entry of entries) {
    const name = /company "([^"]+)"/.exec(entry.description || "")?.[1];
    if (!name) continue;
    const slug = slugifyCompany(name);
    if (slug === currentSlug || slug === INTERNAL_PREFIX) continue;
    if (!seen.includes(slug)) seen.push(slug);
  }
  const history = seen.slice(-5);

  // Written even when empty: an empty array is "already looked", which is what
  // stops this running on every refresh.
  await Company.updateOne({ _id: company._id }, { $set: { slugHistory: history } });
  if (history.length) {
    console.log(`Company brand: forwarding old address${history.length === 1 ? "" : "es"} ${history.map((x) => `/${x}/`).join(", ")} -> /${currentSlug}/`);
  }
  return history;
}

export async function refreshBrand() {
  try {
    const doc = await Company.findOne({ singleton: "COMPANY" }).select("companyName idPrefix slugHistory logo updatedAt _id").lean();
    // `undefined` means this database has never been looked at (the field was
    // added later); `[]` means it has, and there was nothing to forward.
    if (doc?.companyName && doc.slugHistory === undefined) {
      try {
        doc.slugHistory = await seedSlugHistory(doc);
      } catch (seedErr) {
        console.error("COMPANY SLUG HISTORY SEED ERROR:", seedErr);
      }
    }
    setCache(doc?.companyName, doc?.logo, verOf(doc), doc?.idPrefix, doc?.slugHistory);
  } catch (err) {
    console.error("COMPANY BRAND LOOKUP ERROR:", err);
    // leave any previously-loaded value in place; keep retrying if never loaded
    if (!cache.loadedAt) cache = { name: DEFAULT_BRAND, slug: INTERNAL_PREFIX, idPrefix: DEFAULT_ID_PREFIX, pastSlugs: [], logo: null, ver: "0", loadedAt: 0 };
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
