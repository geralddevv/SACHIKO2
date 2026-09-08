import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { reconnectDB } from "../config/db.js";
import { resetTasksConnection } from "../config/tasksDb.js";

// Switching the app onto the database that belongs to a company.
// Triggered from routes/system/company.js when the company name's slug changes
// (a deliberate, confirmed action -- see companyMaster.ejs).
//
//   - target database does NOT exist yet -> create it, seed just the Company
//     record, everything else starts empty.
//   - target database already exists      -> switch straight to it and use its
//     data as-is (nothing is seeded or wiped).
//
// .env is updated so the choice survives a restart, and the live process is
// re-pointed in place (no restart needed). The OLD database is left untouched.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");

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

// Point the app at database `newDb`. If it has no Company record yet, seed it
// with `seedDoc`. Returns { ok, oldDb, newDb, seeded } or { error }.
export async function switchCompanyDb(newDb, seedDoc) {
  const parsed = parseUri(process.env.MONGO_URI || "");
  if (!parsed) return { error: "MONGO_URI is not set or cannot be parsed." };
  if (!fs.existsSync(ENV_PATH)) return { error: ".env file not found -- cannot switch databases." };

  const oldDb = parsed.db;
  if (!newDb || newDb === oldDb) return { ok: true, oldDb, newDb: oldDb, unchanged: true };

  // 1. Seed the target database only if it has no company yet. Use a standalone
  //    connection -- deriving one from mongoose.connection (useDb) and then
  //    closing the main connection for the reconnect leaves the models broken
  //    ("Connection was force closed").
  let seeded = false;
  {
    const seedUri = withAuth(`${parsed.scheme}${parsed.host}/${newDb}${parsed.query}`);
    let seedConn;
    try {
      seedConn = await mongoose.createConnection(seedUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
      const hasCompany = await seedConn.collection("companies").findOne({ singleton: "COMPANY" });
      if (!hasCompany && seedDoc) {
        const doc = { ...seedDoc };
        delete doc.__v;
        await seedConn.collection("companies").insertOne(doc);
        seeded = true;
      }
    } catch (err) {
      return { error: `Could not open the "${newDb}" database: ${err.message}` };
    } finally {
      if (seedConn) await seedConn.close().catch(() => {});
    }
  }

  // 2. Rewrite .env (rolling one-step-back copy in .env.prev).
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
    return { error: `Prepared the database but could not update .env: ${err.message}` };
  }

  // 3. Re-point the live process. process.env must move too so tasksDb.js and a
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
    return { error: `Could not switch the live connection (${err.message}). Reverted; if the app misbehaves, restart it.` };
  }

  return { ok: true, oldDb, newDb, seeded };
}
