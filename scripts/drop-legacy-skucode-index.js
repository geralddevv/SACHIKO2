import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Facestock/Adhesive/Release/Core Master all carry a dead unique index,
// `skuCode_1`, left over from before these collections were renamed to use
// `skuId` (see models/inventory/facestockMaster.js etc. -- none of the
// current schemas declare a `skuCode` field at all). Because the index is
// unique but NOT sparse, every document missing the field is treated as
// `skuCode: null`, and Mongo only allows ONE such document per collection --
// so master creation works exactly once per collection (whoever happened to
// insert first) and then fails for every subsequent create with
// `E11000 duplicate key error ... skuCode_1 dup key: { skuCode: null }`.
//
// This drops that index on all four collections. Safe: it's a plain B-tree
// index with no data behind it (no schema field references skuCode), so
// dropping it can't lose or corrupt anything -- it only removes the dead
// uniqueness constraint that's been blocking creates.
//
// Dry-run by default. Pass --apply to actually drop the index(es).
//
//   node scripts/drop-legacy-skucode-index.js           # preview
//   node scripts/drop-legacy-skucode-index.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const COLLECTIONS = ["facestockmasters", "adhesivemasters", "releasemasters", "coremasters"];

await connectDB();
const db = mongoose.connection.db;

console.log(`Mode: ${APPLY ? "APPLY (dropping index)" : "DRY-RUN (no changes)"}\n`);

for (const name of COLLECTIONS) {
  const exists = await db.listCollections({ name }).toArray();
  if (!exists.length) {
    console.log(`${name} -- collection not found, skipping`);
    continue;
  }
  const indexes = await db.collection(name).indexes();
  const stale = indexes.find((i) => i.name === "skuCode_1");
  if (!stale) {
    console.log(`${name} -- no skuCode_1 index, nothing to do`);
    continue;
  }
  console.log(`${name} -- found skuCode_1 (unique: ${!!stale.unique}, sparse: ${!!stale.sparse})`);
  if (APPLY) {
    await db.collection(name).dropIndex("skuCode_1");
    console.log(`${name} -- dropped`);
  }
}

console.log(APPLY ? "\nChanges committed." : "\nDry-run only. Re-run with --apply to commit.");

await mongoose.connection.close();
process.exit(0);
