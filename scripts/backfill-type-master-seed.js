import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Type from "../models/system/type.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";

// ---------------------------------------------------------------------------
// Seeds the new Type master (models/system/type.js) with every type name
// already in use -- both what's actually saved on existing Facestock/
// Adhesive/Release Master rows, and the values each of those three pages'
// Type dropdown hardcoded before it became a real master (views/inventory/
// masters/facestockMaster.ejs, adhesiveMaster.ejs, releaseMaster.ejs).
// Mirrors scripts/backfill-family-master-seed.js. Run this once before
// relying on the Type master's dropdown, or existing rows would reference a
// type the master doesn't know about yet.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-type-master-seed.js           # preview
//   node scripts/backfill-type-master-seed.js --apply   # commit
// ---------------------------------------------------------------------------

// The three Type <select>'s hardcoded option lists, previously duplicated
// across those views -- kept here too since a value may never have actually
// been saved on any row yet but was still offered as a choice.
const HARDCODED_TYPES = [
  // Facestock Master
  "CLEAR",
  "GLOSSY",
  "GLOSSY DT",
  "MATT",
  "MATT DT",
  "SEMI GLOSSY",
  // Adhesive Master
  "ACRYLIC",
  "HOTMELT",
  "WATERBASE",
  // Release Master
  "CCK",
  "GLASSINE",
  "SCK",
];

const canon = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const [facestockTypes, adhesiveTypes, releaseTypes, existing] = await Promise.all([
  FacestockMaster.distinct("type"),
  AdhesiveMaster.distinct("type"),
  ReleaseMaster.distinct("type"),
  Type.distinct("typeName"),
]);

const existingSet = new Set(existing.map(canon));

const wanted = new Set(
  [...HARDCODED_TYPES, ...facestockTypes, ...adhesiveTypes, ...releaseTypes]
    .map(canon)
    .filter(Boolean),
);

const toCreate = [...wanted].filter((name) => !existingSet.has(name)).sort();

console.log(`Type values in use today (hardcoded lists + Facestock/Adhesive/Release Master): ${wanted.size}`);
console.log(`Already in the Type master: ${existingSet.size}`);
console.log(`To create: ${toCreate.length}\n`);

for (const typeName of toCreate) {
  console.log(`CREATE   ${typeName}`);
  if (APPLY) await Type.create({ typeName });
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Type.db.close();
process.exit(0);
