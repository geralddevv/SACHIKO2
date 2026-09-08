import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import mongoose from "mongoose";
import { reconnectDB } from "../config/db.js";
import { resetTasksConnection } from "../config/tasksDb.js";

// Each company gets its own database under a STABLE, RANDOM name, assigned once
// at registration (routes/system/company.js). Renaming the company afterwards
// only changes the URL slug + display name -- the database is never touched, so
// there is no copy and nothing to go wrong. `renameCompanyDb` below is used just
// for that one-time move at registration (and a legacy migration): it copies the
// whole current database to the new name and re-points the live process, keeping
// the old database as a backup.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");

// A fresh per-company database name -- opaque, so it never collides with a
// company slug and never needs renaming.
export function makeCompanyDbId() {
  return `company_${crypto.randomBytes(9).toString("hex")}`;
}
export function isCompanyDbName(name) {
  return /^company_[a-f0-9]{12,}$/.test(String(name || ""));
}

function parseUri(uri) {
  const m = String(uri || "").match(/^(mongodb(?:\+srv)?:\/\/)([^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) return null;
  return { scheme: m[1], host: m[2], db: m[3] || "", query: m[4] || "" };
}

// The db name the app is currently connected to.
export function currentDbName() {
  return parseUri(process.env.MONGO_URI || "")?.db || "";
}

function swapDbInEnvLine(line, key, oldDb, newDb) {
  return line.replace(
    new RegExp(`^(${key}\\s*=\\s*mongodb(?:\\+srv)?:\\/\\/[^/\\s]+\\/)([^?\\s]+)(.*)$`),
    (_m, head, db, tail) => `${head}${db === oldDb ? newDb : db.split(oldDb).join(newDb)}${tail}`,
  );
}

function withAuth(uri) {
  if (process.env.MONGO_USER && process.env.MONGO_PASS && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASS)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

function mongoAuthArgs() {
  if (process.env.MONGO_USER && process.env.MONGO_PASS) {
    return ["--username", process.env.MONGO_USER, "--password", process.env.MONGO_PASS, "--authenticationDatabase", "admin"];
  }
  return [];
}

async function databaseSizes(parsed) {
  const base = withAuth(`${parsed.scheme}${parsed.host}${parsed.query}`);
  const conn = await mongoose.createConnection(base, { serverSelectionTimeoutMS: 8000 }).asPromise();
  try {
    const { databases } = await conn.db.admin().listDatabases();
    return new Map(databases.map((d) => [d.name, d.sizeOnDisk || 0]));
  } finally {
    await conn.close().catch(() => {});
  }
}

// The `_id` of the Company singleton in another database on the same server --
// used to tell "a stale backup of THIS company" apart from "someone else's data".
async function companyIdInDb(parsed, dbName) {
  const uri = withAuth(`${parsed.scheme}${parsed.host}/${dbName}${parsed.query}`);
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
  try {
    const doc = await conn.collection("companies").findOne({ singleton: "COMPANY" }, { projection: { _id: 1 } });
    return doc ? String(doc._id) : null;
  } finally {
    await conn.close().catch(() => {});
  }
}

// Copy one database to a new name via the MongoDB database tools. Preserves
// indexes and everything else; the source is untouched. `drop` first clears any
// matching collections in the target (used to refresh a stale backup of the
// same company).
function copyDatabase(hostArg, fromDb, toDb, drop = false) {
  const archive = path.join(ROOT, `.dbrename-${fromDb}-${Date.now()}.archive`);
  const auth = mongoAuthArgs();
  const TEN_MIN = 10 * 60 * 1000;
  try {
    execFileSync(
      "mongodump",
      [...auth, "--host", hostArg, `--db=${fromDb}`, `--archive=${archive}`, "--quiet"],
      { stdio: "pipe", timeout: TEN_MIN },
    );
    execFileSync(
      "mongorestore",
      [
        ...auth, "--host", hostArg, `--archive=${archive}`,
        `--nsFrom=${fromDb}.*`, `--nsTo=${toDb}.*`,
        ...(drop ? ["--drop"] : []),
        "--quiet",
      ],
      { stdio: "pipe", timeout: TEN_MIN },
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("MongoDB database tools (mongodump/mongorestore) are not installed on the server.");
    }
    const detail = err.stderr ? String(err.stderr).trim().split("\n").pop() : err.message;
    throw new Error(detail || "database copy failed");
  } finally {
    if (fs.existsSync(archive)) { try { fs.unlinkSync(archive); } catch { /* leave it */ } }
  }
}

// Copy the current database (and its <db>_tasks sibling) to `newDb`, then point
// .env and the live process at it. The old database is kept as a backup.
// Returns { ok, oldDb, newDb } or { error }.
export async function renameCompanyDb(newDb, { companyId = null } = {}) {
  const parsed = parseUri(process.env.MONGO_URI || "");
  if (!parsed) return { error: "MONGO_URI is not set or cannot be parsed." };
  if (!fs.existsSync(ENV_PATH)) return { error: ".env file not found -- cannot rename the database." };

  const oldDb = parsed.db;
  if (!newDb || newDb === oldDb) return { ok: true, oldDb, newDb: oldDb, unchanged: true };

  const hostArg = parsed.host.includes("@") ? parsed.host.split("@").pop() : parsed.host;
  const oldTasksDb = `${oldDb}_tasks`;
  const newTasksDb = `${newDb}_tasks`;

  // 1. If the target already holds data, only proceed when it's a stale backup
  //    of THIS same company (same Company _id) -- then overwrite it. Otherwise
  //    refuse: a rename must never clobber an unrelated dataset.
  let sizes;
  try {
    sizes = await databaseSizes(parsed);
  } catch (err) {
    return { error: `Could not check the target database: ${err.message}` };
  }
  let overwrite = false;
  if ((sizes.get(newDb) || 0) > 0) {
    let targetCompanyId = null;
    try {
      targetCompanyId = await companyIdInDb(parsed, newDb);
    } catch { /* treat as unknown -> refuse below */ }
    if (companyId && targetCompanyId && targetCompanyId === String(companyId)) {
      overwrite = true; // an old backup of this company -- safe to refresh
    } else {
      return {
        error: `A database named "${newDb}" already exists and holds a different company's data. Choose a different company name, or remove that database first.`,
      };
    }
  }

  // 2. Copy the whole current database (+ its tasks sibling) to the new name.
  try {
    copyDatabase(hostArg, oldDb, newDb, overwrite);
    if ((sizes.get(oldTasksDb) || 0) > 0) copyDatabase(hostArg, oldTasksDb, newTasksDb, overwrite);
  } catch (err) {
    return { error: `Could not copy the database (${err.message}). Nothing was changed.` };
  }

  // 3. Rewrite .env (rolling one-step-back copy in .env.prev).
  const originalEnv = fs.readFileSync(ENV_PATH, "utf8");
  try {
    const nextEnv = originalEnv
      .split("\n")
      .map((l) => {
        if (/^MONGO_URI\s*=/.test(l)) return swapDbInEnvLine(l, "MONGO_URI", oldDb, newDb);
        if (/^TASKS_MONGO_URI\s*=/.test(l)) return swapDbInEnvLine(l, "TASKS_MONGO_URI", oldDb, newDb);
        return l;
      })
      .join("\n");
    fs.writeFileSync(`${ENV_PATH}.prev`, originalEnv);
    fs.writeFileSync(ENV_PATH, nextEnv);
  } catch (err) {
    return { error: `Copied the database but could not update .env: ${err.message}` };
  }

  // 4. Re-point the live process. process.env must move too so tasksDb.js and a
  //    future reconnect read the new value.
  const prevMongoUri = process.env.MONGO_URI;
  const prevTasksUri = process.env.TASKS_MONGO_URI;
  process.env.MONGO_URI = swapDbInEnvLine(`MONGO_URI=${prevMongoUri}`, "MONGO_URI", oldDb, newDb).slice("MONGO_URI=".length);
  if (prevTasksUri) {
    process.env.TASKS_MONGO_URI = swapDbInEnvLine(`TASKS_MONGO_URI=${prevTasksUri}`, "TASKS_MONGO_URI", oldDb, newDb).slice("TASKS_MONGO_URI=".length);
  }

  try {
    await reconnectDB();
    await resetTasksConnection();
  } catch (err) {
    process.env.MONGO_URI = prevMongoUri;
    if (prevTasksUri) process.env.TASKS_MONGO_URI = prevTasksUri;
    try { fs.writeFileSync(ENV_PATH, originalEnv); } catch { /* noted below */ }
    try { await reconnectDB(); } catch { /* connection already lost -- restart needed */ }
    return { error: `Copied the database but could not switch the live connection (${err.message}). Reverted; restart the server if it misbehaves.` };
  }

  return { ok: true, oldDb, newDb };
}
