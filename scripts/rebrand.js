#!/usr/bin/env node
/*
 * ONE-TIME REBRAND -- point the whole app at a new, FRESH company.
 *
 *   node scripts/rebrand.js <slug> ["Display Name"]            # dry run (default)
 *   node scripts/rebrand.js <slug> ["Display Name"] --apply    # actually do it
 *   node scripts/rebrand.js <slug> --from <current-slug>       # override auto-detect
 *
 * <slug> becomes the URL prefix (/<from>/...  ->  /<slug>/...) and the name of a
 * BRAND-NEW, EMPTY MongoDB database. No data is copied -- the new company starts
 * from zero and is set up through the app (register it at /<slug>/form/company).
 *
 * <current-slug> is auto-detected from the db name in .env MONGO_URI (falling
 * back to "sachiko"); pass --from to override.
 *
 * What --apply changes, in order:
 *   1. Every quoted "/<from>/..." URL literal in .js / .ejs  ->  "/<slug>/..."
 *      (route mounts, redirects, <a href>, fetch(), <form action>, meta tags).
 *      Import paths like  models/sachiko/x.js  are NOT touched -- only quoted
 *      URL strings are. Comment-only mentions are left alone.
 *   2. The session cookie name  <from>.sid  ->  <slug>.sid  (everyone is logged
 *      out once -- their old cookie no longer matches).
 *   3. config/tasksDb.js fallback db names  <from>(_tasks)  ->  <slug>(_tasks).
 *   4. .env  MONGO_URI  (and TASKS_MONGO_URI if present) db segment  ->  <slug>.
 *      The old .env is copied to .env.pre-rebrand.
 *   5. Nothing is done to any database. MongoDB creates the empty "<slug>"
 *      database by itself the first time the app writes to it. The old database
 *      is left completely untouched.
 *
 * The internal brand token "sachiko" (res.locals.selfBrand, the fairdesk/sachiko
 * switch on the shared login) is deliberately left as-is -- it is not a URL or a
 * database name and is never shown to users.
 *
 * After --apply: restart the server, open /<slug>/form/company to register the
 * new company, and update the base URL in the operator mobile app (its endpoint
 * moves to /<slug>/api/operator).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../config/loadEnv.js";
import mongoose from "mongoose";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const rawArgs = process.argv.slice(2);
const APPLY = rawArgs.includes("--apply");
const FORCE = rawArgs.includes("--force");
const fromFlagIdx = rawArgs.indexOf("--from");
const fromFlag = fromFlagIdx !== -1 ? rawArgs[fromFlagIdx + 1] : null;
const positional = rawArgs.filter((a, i) => !a.startsWith("--") && i !== fromFlagIdx + 1);
const slug = String(positional[0] || "").trim().toLowerCase();
const displayName = String(positional[1] || "").trim();

/* ------------------------------------------------------------------ guards */

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVED = new Set([
  "fairtech", "fairdesk", "login", "logout", "assets", "js", "css", "images",
  "media", "bootstrap", "favicon.ico", "check-session", "debug-image", "api",
  "public", "node_modules",
]);

if (!slug) {
  console.error('Usage: node scripts/rebrand.js <slug> ["Display Name"] [--from <current-slug>] [--apply]');
  process.exit(1);
}
if (!SLUG_RE.test(slug)) {
  console.error(`Invalid slug "${slug}". Use 2-31 chars: lowercase letter first, then letters/digits/hyphen.`);
  process.exit(1);
}
if (RESERVED.has(slug)) {
  console.error(`Slug "${slug}" is reserved -- pick another.`);
  process.exit(1);
}

/* ----------------------------------------------------- current ("from") slug */

function parseUri(uri) {
  const m = String(uri || "").match(/^(mongodb(?:\+srv)?:\/\/)([^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) return null;
  return { scheme: m[1], host: m[2], db: m[3] || "", query: m[4] || "" };
}

const mainUri = process.env.MONGO_URI || "";
const parsed = parseUri(mainUri);
const OLD_SLUG = String(fromFlag || parsed?.db || "sachiko").trim().toLowerCase();

if (!SLUG_RE.test(OLD_SLUG)) {
  console.error(`Could not determine the current slug (got "${OLD_SLUG}"). Pass --from <current-slug>.`);
  process.exit(1);
}
if (OLD_SLUG === slug) {
  console.error(`Current slug and new slug are both "${slug}" -- nothing to do.`);
  process.exit(1);
}

const oldDb = parsed?.db || OLD_SLUG;
const newDb = oldDb === OLD_SLUG ? slug : oldDb.split(OLD_SLUG).join(slug);
const oldTasksDb = process.env.TASKS_MONGO_URI
  ? parseUri(process.env.TASKS_MONGO_URI)?.db || `${oldDb}_tasks`
  : `${oldDb}_tasks`;
const newTasksDb = oldTasksDb.split(OLD_SLUG).join(slug);

/* --------------------------------------------------------------- file scan */

const SKIP_DIRS = new Set([".git", "node_modules", "media", "images", "coverage"]);
const SKIP_REL = new Set(["scripts/archive"]);
const SELF_REL = path.relative(ROOT, fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_REL.has(rel)) continue;
      walk(full, out);
    } else if (/\.(js|ejs)$/.test(entry.name) && rel !== SELF_REL) {
      out.push(full);
    }
  }
  return out;
}

// Only quoted URL literals:  <quote>/<from>(  /  | same quote )
// so  "../../models/sachiko/x.js"  (a letter before /sachiko) is never matched.
const URL_RE = new RegExp(`(['"\\\`])\\/${OLD_SLUG}(\\/|\\1)`, "g");
const COOKIE_RE = new RegExp(`${OLD_SLUG}\\.sid`, "g");

function rewriteGeneric(content) {
  let count = 0;
  let next = content.replace(URL_RE, (_m, q, tail) => { count++; return `${q}/${slug}${tail}`; });
  next = next.replace(COOKIE_RE, () => { count++; return `${slug}.sid`; });
  return { next, count };
}

const files = walk(ROOT);
const changes = [];
let totalReplacements = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const content = fs.readFileSync(file, "utf8");

  let next, count;
  if (rel === "config/tasksDb.js") {
    // This file has no <from>-named imports -- every occurrence is a fallback
    // database name, so a blanket swap is safe and correct.
    const re = new RegExp(OLD_SLUG, "g");
    count = (content.match(re) || []).length;
    next = content.replace(re, slug);
  } else {
    ({ next, count } = rewriteGeneric(content));
  }

  if (count > 0 && next !== content) {
    changes.push({ rel, count });
    totalReplacements += count;
    if (APPLY) fs.writeFileSync(file, next);
  }
}

/* -------------------------------------------------------------------- .env */

const envPath = path.join(ROOT, ".env");
let envReport = null;
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, "utf8");
  const swapDbInUri = (line) =>
    line.replace(
      /^((?:MONGO_URI|TASKS_MONGO_URI)\s*=\s*mongodb(?:\+srv)?:\/\/[^/\s]+\/)([^?\s]+)(.*)$/,
      (_m, head, db, tail) => `${head}${db.split(OLD_SLUG).join(slug)}${tail}`,
    );
  let lines = env
    .split("\n")
    .map((l) => (/^(MONGO_URI|TASKS_MONGO_URI)\s*=/.test(l) ? swapDbInUri(l) : l));
  // APP_BRAND_NAME is the header/title/login fallback shown until the new
  // company is registered from /<slug>/form/company (see utils/companyBrand.js).
  if (displayName) {
    const brandLine = `APP_BRAND_NAME=${displayName}`;
    const idx = lines.findIndex((l) => /^APP_BRAND_NAME\s*=/.test(l));
    if (idx !== -1) lines[idx] = brandLine;
    else lines.push(brandLine);
  }
  const nextEnv = lines.join("\n");
  envReport = { changed: nextEnv !== env };
  if (APPLY && envReport.changed) {
    fs.copyFileSync(envPath, path.join(ROOT, ".env.pre-rebrand"));
    fs.writeFileSync(envPath, nextEnv);
  }
}

/* ------------------------------------------------------- fresh-db guard */

function withAuth(uri) {
  if (process.env.MONGO_USER && process.env.MONGO_PASS && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASS)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}
const hostArg = withAuth(parsed ? `${parsed.scheme}${parsed.host}${parsed.query}` : "mongodb://localhost:27017");

async function nonEmptyDatabases(names) {
  const conn = await mongoose.createConnection(hostArg, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const { databases } = await conn.db.admin().listDatabases();
    return names.filter((n) => {
      const hit = databases.find((d) => d.name === n);
      return hit && (hit.sizeOnDisk || 0) > 0;
    });
  } finally {
    await conn.close();
  }
}

/* ----------------------------------------------------------------- report */

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} -- rebrand  ${OLD_SLUG}  ->  ${slug}   (fresh, empty database)\n`);
console.log(`  URL prefix : /${OLD_SLUG}/...   ->  /${slug}/...`);
console.log(`  cookie     : ${OLD_SLUG}.sid    ->  ${slug}.sid`);
console.log(`  database   : ${oldDb}    ->  ${newDb}   (created empty on first write; "${oldDb}" untouched)`);
console.log(`  tasks db   : ${oldTasksDb}  ->  ${newTasksDb}  (created empty on first write)`);
if (displayName) console.log(`  company    : register at /${slug}/form/company as "${displayName.toUpperCase()}"`);
console.log(`\n  ${changes.length} files, ${totalReplacements} URL/cookie replacements:`);
for (const c of changes.sort((a, b) => b.count - a.count)) {
  console.log(`    ${String(c.count).padStart(4)}  ${c.rel}`);
}
console.log(`\n  .env: ${envReport ? (envReport.changed ? "MONGO_URI db segment rewritten (backup -> .env.pre-rebrand)" : "no change needed") : `not found -- set MONGO_URI db name to "${newDb}" yourself`}`);

if (!APPLY) {
  console.log(`\nNothing was written. Re-run with --apply to perform the rebrand.\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ apply */

(async () => {
  try {
    const clash = await nonEmptyDatabases([newDb, newTasksDb]);
    if (clash.length && !FORCE) {
      console.error(`\nThe target database${clash.length > 1 ? "s" : ""} ${clash.map((n) => `"${n}"`).join(" and ")} already exist${clash.length > 1 ? "" : "s"} and hold data.`);
      console.error(`A fresh company must start on an empty database. Drop ${clash.length > 1 ? "them" : "it"} first, or pass --force if you know what you're doing.`);
      console.error(`(Code + .env changes are ALREADY written -- restore with git + .env.pre-rebrand if you're stopping here.)`);
      process.exit(1);
    }
  } catch (err) {
    console.warn(`\nCould not check the target database ("${err.message}") -- continuing anyway; make sure "${newDb}" is empty.`);
  }

  console.log(`\nDONE. Next steps:`);
  console.log(`  1. Restart the server.`);
  console.log(`  2. Open  /${slug}/form/company  and register the new company.`);
  console.log(`  3. Sign in at  /${slug}/login  (the old session cookie is dead).`);
  console.log(`  4. Update the operator mobile app base URL  ->  /${slug}/api/operator\n`);
  process.exit(0);
})();
