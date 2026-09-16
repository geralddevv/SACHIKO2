import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Location from "../models/system/location.js";
import Employee from "../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// Seeds the Location master (models/system/location.js) with every location
// already in use on employee records, plus the values the Employee form's
// Location dropdown hardcoded before it started reading the master
// (views/hr/employee.ejs). Mirrors scripts/backfill-type-master-seed.js.
//
// Run this once before relying on that dropdown: the master started out with
// only the locations someone happened to add by hand, so without seeding, an
// employee posted at OFFICE has a location the master has never heard of and
// HR cannot file a new joiner there.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-location-master-seed.js           # preview
//   node scripts/backfill-location-master-seed.js --apply   # commit
// ---------------------------------------------------------------------------

// The Location <select>'s old hardcoded option list -- kept here too, since a
// value may never have been saved on any employee yet but was still offered.
const HARDCODED_LOCATIONS = [
  "OFFICE",
  "UNIT 1",
  "UNIT 2",
  "PALGHAR",
  "VAPI",
  "AURANGABAD",
  "WFH",
];

// Same normalisation utils/locations.js applies, so "Vapi" and "VAPI" are one
// location rather than two rows in the master.
const canon = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const [employeeLocations, existing] = await Promise.all([
  Employee.distinct("empLoc"),
  Location.distinct("locationName"),
]);

const existingSet = new Set(existing.map(canon));

const wanted = new Set([...HARDCODED_LOCATIONS, ...employeeLocations].map(canon).filter(Boolean));

const toCreate = [...wanted].filter((name) => !existingSet.has(name)).sort();

console.log(`Location values in use today (hardcoded list + employee records): ${wanted.size}`);
console.log(`Already in the Location master: ${existingSet.size}`);
console.log(`To create: ${toCreate.length}\n`);

for (const locationName of toCreate) {
  console.log(`CREATE   ${locationName}`);
  if (APPLY) await Location.create({ locationName });
}

// An employee row spelled differently to the master ("Vapi" vs "VAPI") still
// resolves -- the form matches case-insensitively -- but flag it so it's clear
// which rows will pick up the master's spelling next time they're saved.
const mismatched = employeeLocations.filter((loc) => loc && loc !== canon(loc));
if (mismatched.length) {
  console.log(`\nEmployee locations stored in a different case to the master: ${JSON.stringify(mismatched)}`);
  console.log("These still match (comparisons normalise) and will take the master's spelling when re-saved.");
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Location.db.close();
process.exit(0);
