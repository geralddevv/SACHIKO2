import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../../config/db.js";
import Counter from "../../models/system/counter.js";

const APPLY = process.argv.includes("--apply");

await connectDB();
const db = mongoose.connection.db;

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const collections = (await db.listCollections().toArray()).map((c) => c.name);
const hasOld = collections.includes("datasheets");
const hasNew = collections.includes("sls");

if (!hasOld && hasNew) {
  console.log('Collection "datasheets" not found but "sls" already exists -- migration looks already applied. Nothing to do.');
  process.exit(0);
}

if (!hasOld && !hasNew) {
  console.log('Collection "datasheets" not found -- nothing to migrate (no SL/Datasheet records exist yet).');
  process.exit(0);
}

let slsAutoVivified = false;
if (hasOld && hasNew) {
  // The app itself creates an empty "sls" collection (just its unique index,
  // no documents) the moment it connects, because the SachikoSL model
  // declares that collection name and Mongoose's autoIndex vivifies it on
  // startup -- that's not real data to protect, just a side effect of the
  // new model existing. Only refuse if "sls" actually holds documents.
  const slsCount = await db.collection("sls").countDocuments();
  if (slsCount > 0) {
    console.error(`Both "datasheets" and "sls" collections exist, and "sls" already has ${slsCount} document(s) -- refusing to guess which is authoritative. Resolve manually before re-running.`);
    process.exit(1);
  }
  slsAutoVivified = true;
}

const oldColl = db.collection("datasheets");
const docCount = await oldColl.countDocuments();
const indexes = await oldColl.indexes();
const oldIdIndex = indexes.find((i) => i.key && Object.keys(i.key).length === 1 && i.key.datasheetId === 1 && i.name !== "_id_");

console.log(`Documents in "datasheets": ${docCount}`);
console.log(`Unique index on datasheetId: ${oldIdIndex ? oldIdIndex.name : "(none found)"}`);

const oldCounter = await Counter.findOne({ key: "sachikoDatasheetId" }).lean();
console.log(`Counter "sachikoDatasheetId": ${oldCounter ? `seq=${oldCounter.seq}` : "(none found)"}`);

const oldUploadDir = path.resolve("uploads/sachiko/datasheets");
const newUploadDir = path.resolve("uploads/sachiko/sls");
const uploadFiles = fs.existsSync(oldUploadDir) ? fs.readdirSync(oldUploadDir) : [];
console.log(`Word files in uploads/sachiko/datasheets: ${uploadFiles.length}`);

if (slsAutoVivified) {
  console.log('Note: "sls" already exists but is empty -- it was auto-created by the app\'s own startup indexing, not real data. It will be replaced.');
}

if (!APPLY) {
  console.log("\nDry-run only. Re-run with --apply to commit:");
  if (oldIdIndex) console.log(`  1. drop index "${oldIdIndex.name}" on datasheets`);
  console.log(`  2. rename collection "datasheets" -> "sls"${slsAutoVivified ? " (replacing the empty auto-created one)" : ""}`);
  console.log(`  3. rename field datasheetId -> slId on ${docCount} document(s)`);
  console.log(`  4. create unique index on sls.slId`);
  console.log(`  5. rename Counter key sachikoDatasheetId -> sachikoSLId`);
  if (uploadFiles.length) console.log(`  6. move ${uploadFiles.length} file(s) from uploads/sachiko/datasheets -> uploads/sachiko/sls`);
  process.exit(0);
}

// 1. Drop the old unique index -- otherwise the $rename below leaves every
// document's index entry momentarily null, and a non-sparse unique index
// only tolerates one null.
if (oldIdIndex) {
  await oldColl.dropIndex(oldIdIndex.name);
  console.log(`Dropped index "${oldIdIndex.name}"`);
}

// 2. Rename the collection (dropTarget clears the empty auto-vivified "sls"
// collection if the app already spun one up).
await db.renameCollection("datasheets", "sls", { dropTarget: true });
console.log('Renamed collection "datasheets" -> "sls"');

const newColl = db.collection("sls");

// 3. Rename the field on every document.
const renameResult = await newColl.updateMany({}, { $rename: { datasheetId: "slId" } });
console.log(`Renamed field on ${renameResult.modifiedCount} document(s)`);

// 4. Rebuild the unique index under its new name.
await newColl.createIndex({ slId: 1 }, { unique: true });
console.log("Created unique index on sls.slId");

// 5. Carry the running sequence number over so new ids continue numbering
// rather than restarting at 1.
if (oldCounter) {
  await Counter.updateOne({ key: "sachikoDatasheetId" }, { $set: { key: "sachikoSLId" } });
  console.log(`Renamed Counter key sachikoDatasheetId -> sachikoSLId (seq=${oldCounter.seq})`);
}

// 6. Move any uploaded word files across.
if (uploadFiles.length) {
  fs.mkdirSync(newUploadDir, { recursive: true });
  for (const file of uploadFiles) {
    fs.renameSync(path.join(oldUploadDir, file), path.join(newUploadDir, file));
  }
  console.log(`Moved ${uploadFiles.length} file(s) to uploads/sachiko/sls`);
  try {
    fs.rmdirSync(oldUploadDir);
  } catch {
    // Non-empty or in use -- leave it, nothing critical depends on it being removed.
  }
}

console.log("\nMigration complete.");
await mongoose.connection.close();
process.exit(0);
