import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// One-way copy of the Tape master from FAIRTECH's "fairdesk" database into
// this app's "sachiko" database. Read-only on the fairdesk side -- nothing
// is ever written or deleted there.
//
// Match key is tapeProductId (unique in both apps). For each fairdesk tape:
//   - no sachiko tape shares its tapeProductId  -> inserted as a new document
//   - a sachiko tape already has that tapeProductId -> overwritten in place
//     (sachiko's existing _id is kept, every other field is replaced with
//     fairdesk's values)
//
// Dry-run by default -- prints exactly what would be inserted/overwritten
// and does not touch either database. Pass --apply to commit.
//
//   node scripts/migrate-fairdesk-tapes.js           # preview
//   node scripts/migrate-fairdesk-tapes.js --apply   # commit
//
// Source defaults to a sibling "fairdesk" database on the same server as
// MONGO_URI (mirrors config/tasksDb.js's sibling-db pattern); override with
// FAIRDESK_MONGO_URI if fairdesk lives elsewhere.
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

function withAuth(uri) {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

// Points at a sibling "fairdesk" database on the same server/cluster as the
// main app -- same credentials, different database name.
function deriveFairdeskUri(mainUri) {
  const schemeSepIdx = mainUri.indexOf("//");
  if (schemeSepIdx === -1) return mainUri;

  const prefix = mainUri.slice(0, schemeSepIdx + 2);
  const afterScheme = mainUri.slice(schemeSepIdx + 2);
  const pathIdx = afterScheme.indexOf("/");
  if (pathIdx === -1) return `${prefix}${afterScheme}/fairdesk`;

  const hostPart = afterScheme.slice(0, pathIdx);
  const rest = afterScheme.slice(pathIdx + 1);
  const qIdx = rest.indexOf("?");
  const query = qIdx === -1 ? "" : rest.slice(qIdx);

  return `${prefix}${hostPart}/fairdesk${query}`;
}

const mainUri = process.env.MONGO_URI || "mongodb://localhost:27017/sachiko";
const sachikoUri = withAuth(mainUri);
const fairdeskUri = withAuth(process.env.FAIRDESK_MONGO_URI || deriveFairdeskUri(mainUri));

const sachikoConn = await mongoose.createConnection(sachikoUri).asPromise();
const fairdeskConn = await mongoose.createConnection(fairdeskUri).asPromise();
console.log(`Connected to sachiko (${sachikoConn.name}) and fairdesk (${fairdeskConn.name})\n`);

const sachikoTapes = sachikoConn.collection("tapes");
const fairdeskTapes = fairdeskConn.collection("tapes");

const sourceDocs = await fairdeskTapes.find({}).toArray();
const existingIds = new Set((await sachikoTapes.find({}, { projection: { tapeProductId: 1 } }).toArray()).map((d) => d.tapeProductId));

const toInsert = sourceDocs.filter((d) => !existingIds.has(d.tapeProductId));
const toOverwrite = sourceDocs.filter((d) => existingIds.has(d.tapeProductId));

console.log(`fairdesk.tapes: ${sourceDocs.length} document(s)`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

console.log(`New tapes to insert (${toInsert.length}):`);
for (const d of toInsert) console.log(`  INSERT     ${d.tapeProductId}  (${d.tapePaperType}, ${d.tapeWidth}mm)`);

console.log(`\nExisting tapes to overwrite (${toOverwrite.length}):`);
for (const d of toOverwrite) console.log(`  OVERWRITE  ${d.tapeProductId}  (${d.tapePaperType}, ${d.tapeWidth}mm)`);

if (APPLY) {
  for (const d of toInsert) {
    const { _id, ...rest } = d;
    await sachikoTapes.insertOne(rest);
  }
  for (const d of toOverwrite) {
    const { _id, ...rest } = d;
    await sachikoTapes.replaceOne({ tapeProductId: d.tapeProductId }, rest);
  }
  console.log("\nChanges committed. fairdesk.tapes was not modified.");
} else {
  console.log("\nDry-run only. Re-run with --apply to commit.");
}

await sachikoConn.close();
await fairdeskConn.close();
process.exit(0);
