import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Drops the collections listed (one per line) in dropCollection.txt at the
// project root -- leftovers from renamed/removed features (ttr -> tape,
// tafeta, posroll, colorlabel, datasheet -> label stock, etc.) that no
// current Mongoose model points to. See CLAUDE.md's model list; cross-check
// with `mongoose.modelNames()` before adding anything to that file.
//
// Refuses to drop any collection that isn't empty, even with --apply --
// re-run after clearing/reviewing its data if that ever legitimately
// changes. Dry-run by default.
//
//   node scripts/drop-unused-collections.js           # preview
//   node scripts/drop-unused-collections.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const LIST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dropCollection.txt");

const names = fs
  .readFileSync(LIST_PATH, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

if (!names.length) {
  console.log(`No collection names found in ${LIST_PATH}`);
  process.exit(0);
}

await connectDB();
const db = mongoose.connection.db;

console.log(`Mode: ${APPLY ? "APPLY (dropping collections)" : "DRY-RUN (no changes)"}`);
console.log(`Candidates (${names.length}): ${names.join(", ")}\n`);

for (const name of names) {
  const exists = await db.listCollections({ name }).toArray();
  if (!exists.length) {
    console.log(`${name} -- not found, skipping`);
    continue;
  }

  const count = await db.collection(name).countDocuments();
  if (count > 0) {
    console.log(`${name} -- SKIPPED: has ${count} document(s), refusing to drop non-empty collection`);
    continue;
  }

  console.log(`${name} -- empty, ${APPLY ? "dropping" : "would drop"}`);
  if (APPLY) {
    await db.dropCollection(name);
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await mongoose.connection.close();
process.exit(0);
