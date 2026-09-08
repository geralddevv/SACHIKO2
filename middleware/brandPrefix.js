import { currentBrand, ensureFreshBrand, INTERNAL_PREFIX } from "../utils/companyBrand.js";

// Every route in this app is registered under a constant internal prefix
// ("/app", INTERNAL_PREFIX). The prefix the user actually sees in the address
// bar is the company slug (utils/companyBrand.js), which changes the moment the
// Company master is registered or renamed -- no restart, no code edits.
//
// This middleware bridges the two:
//   inbound   /<slug>/x   ->  request rewritten to  /app/x   (routes never know)
//   outbound  /app/x     ->  /<slug>/x   in rendered HTML, in JSON `redirect`
//               fields, and in res.redirect() targets / Location headers
//
// /app/x always keeps working directly too (client-side fetches, bookmarks),
// so nothing breaks in the gap before a company is registered (slug === "app").

const INT = `/${INTERNAL_PREFIX}`;

// The internal prefix as a real path token only: start-of-string or a
// delimiter, then "/app", then a path boundary. Matches
//   /app   /app/x   "/app"   href="/app/x"   `/app/${id}`
// never  /appfoo  or  ../models/sachiko/x.js
const OUT_RE = new RegExp(`(^|[\\s"'\`(=>])\\/${INTERNAL_PREFIX}(?=[/"'\`)\\s?#<]|$)`, "g");

const wantsHtml = (req) =>
  req.method === "GET" &&
  !req.xhr &&
  String(req.headers.accept || "").includes("text/html");

export function brandPrefix(req, res, next) {
  ensureFreshBrand();
  const { slug } = currentBrand();
  const pub = `/${slug}`;

  res.locals.brandSlug = slug;
  res.locals.P = pub;

  if (slug === INTERNAL_PREFIX) return next(); // no company registered yet

  const url = req.url;

  if (url === pub || url.startsWith(`${pub}/`) || url.startsWith(`${pub}?`)) {
    // Public -> internal, for this request and anything reading originalUrl.
    req.url = INT + url.slice(pub.length);
    req.originalUrl = req.url;
  } else if (
    (url === INT || url.startsWith(`${INT}/`) || url.startsWith(`${INT}?`)) &&
    wantsHtml(req)
  ) {
    // Raw internal URL opened in a browser -> bounce to the pretty one. Non-HTML
    // hits on /app/* are left alone so client fetches / bookmarks keep working.
    return res.redirect(301, pub + url.slice(INT.length));
  }

  const toPublic = (s) =>
    typeof s === "string" ? s.replace(OUT_RE, (_m, pre) => `${pre}${pub}`) : s;

  const origRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    const target = args.pop();
    return origRedirect(...args, toPublic(target));
  };

  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === "string") {
      // Content-Type is often still unset here (res.render -> res.send sets it
      // to text/html *inside* send). Treat an unset type as HTML, which is what
      // Express is about to do anyway.
      const ct = String(res.get("Content-Type") || "");
      if (!ct || /html|json|javascript/i.test(ct)) {
        body = toPublic(body);
      }
    }
    return origSend(body);
  };

  next();
}
