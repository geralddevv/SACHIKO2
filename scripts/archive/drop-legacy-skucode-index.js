import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";

// ---------------------------------------------------------------------------
// One-time repair for FacestockMaster/AdhesiveMaster/ReleaseMaster/CoreMaster.
//
// All four collections carry a leftover `skuCode_1` unique index from before
// these masters were renamed to use `skuId` -- no model has ever defined a
// `skuCode` field, so every document has it missing. A *non-sparse* unique
// index treats a missing field as `null`, and only one document may hold
// `null`, so as soon as one row exists, every later create/edit fails with a
// duplicate-key error on `skuCode` -- unrelated to which fields the user
// actually changed. Removing the field from the schema doesn't drop an index
// already built on the collection, hence this script.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/drop-legacy-skucode-index.js           # preview
//   node scripts/drop-legacy-skucode-index.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const OLD_INDEX_NAME = "skuCode_1";
const COLLECTIONS = ["facestockmasters", "adhesivemasters", "releasemasters", "coremasters"];

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const mongoose = (await import("mongoose")).default;
const db = mongoose.connection.db;

for (const name of COLLECTIONS) {
  const coll = db.collection(name);
  const indexes = await coll.indexes();
  const oldIndex = indexes.find((idx) => idx.name === OLD_INDEX_NAME);
  if (!oldIndex) {
    console.log(`${name}: index ${OLD_INDEX_NAME} not present -- nothing to drop.`);
    continue;
  }
  console.log(`${name}: old index found: ${OLD_INDEX_NAME}`);
  if (APPLY) {
    await coll.dropIndex(OLD_INDEX_NAME);
    console.log(`  -> dropped.`);
  } else {
    console.log(`  -> would drop (re-run with --apply).`);
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await mongoose.connection.close();
process.exit(0);
