import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Family from "../models/system/family.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";

// ---------------------------------------------------------------------------
// Seeds the new Family master (models/system/family.js) with every family
// name already in use -- both what's actually saved on existing Label Stock /
// Facestock Master rows, and the 17 values the Family dropdown on those two
// pages hardcoded before it became a real master (views/sachiko/
// labelStockView.ejs and views/inventory/masters/facestockMaster.ejs). Run
// this once before relying on the Family master's dropdown, or existing rows
// would reference a family the master doesn't know about yet.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-family-master-seed.js           # preview
//   node scripts/backfill-family-master-seed.js --apply   # commit
// ---------------------------------------------------------------------------

// The Family <select>'s hardcoded option list, previously duplicated in both
// views above -- kept here too since a value may never have actually been
// saved on any row yet but was still offered as a choice.
const HARDCODED_FAMILIES = [
  "CHROMO",
  "CHROMO (D. R)",
  "CLEAR PP",
  "DOUBLE RELEASE",
  "DT",
  "DT. PP",
  "GLOSSY PP",
  "GLOSSY PP PARTIAL",
  "INKJET MATT FILM",
  "MAPLITO",
  "MATT PP",
  "MATT PP (HT)",
  "MATT PP PARTIAL",
  "PP",
  "REMOVABLE",
  "SILVER VOID",
  "SUPER HOTMELT",
];

const canon = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const [labelStockFamilies, facestockFamilies, existing] = await Promise.all([
  SachikoLabelStock.distinct("family"),
  FacestockMaster.distinct("family"),
  Family.distinct("familyName"),
]);

const existingSet = new Set(existing.map(canon));

const wanted = new Set(
  [...HARDCODED_FAMILIES, ...labelStockFamilies, ...facestockFamilies]
    .map(canon)
    .filter(Boolean),
);

const toCreate = [...wanted].filter((name) => !existingSet.has(name)).sort();

console.log(`Family values in use today (hardcoded list + Label Stock + Facestock Master): ${wanted.size}`);
console.log(`Already in the Family master: ${existingSet.size}`);
console.log(`To create: ${toCreate.length}\n`);

for (const familyName of toCreate) {
  console.log(`CREATE   ${familyName}`);
  if (APPLY) await Family.create({ familyName });
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Family.db.close();
process.exit(0);
