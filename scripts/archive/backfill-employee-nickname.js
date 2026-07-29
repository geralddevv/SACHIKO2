import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../../config/db.js";
import Employee from "../../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// One-time backfill for the Employee "Nick Name" field (empNickName).
//
// Many employees are stored with a full three-word name, which is unwieldy
// everywhere a short call-name is wanted. The form (views/hr/employee.ejs)
// pre-fills Nick Name with the first word of the Name for new/edited records;
// this does the same for records that already exist.
//
// Only employees with an EMPTY empNickName are touched, so a nick name someone
// set by hand is never clobbered. Pass --overwrite to re-derive every nick name
// from the Name instead.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-employee-nickname.js                      # preview
//   node scripts/backfill-employee-nickname.js --apply              # commit
//   node scripts/backfill-employee-nickname.js --overwrite --apply  # re-derive all
// ---------------------------------------------------------------------------

// Keep this identical to the firstWord() helper in views/hr/employee.ejs.
function firstWord(value) {
  return String(value ?? "").trim().split(/\s+/)[0] || "";
}

const APPLY = process.argv.includes("--apply");
const OVERWRITE = process.argv.includes("--overwrite");

await connectDB();

const employees = await Employee.find({}, "empName empNickName empProfileCode")
  .collation({ locale: "en", strength: 2 })
  .sort({ empName: 1 })
  .lean();

console.log(`Employees: ${employees.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}${OVERWRITE ? " + OVERWRITE" : ""}\n`);

let filled = 0;
let skipped = 0;
let noName = 0;

for (const emp of employees) {
  const label = `${emp.empName || "(no name)"}${emp.empProfileCode ? ` [${emp.empProfileCode}]` : ""} (_id ${emp._id})`;
  const existing = String(emp.empNickName ?? "").trim();
  const nick = firstWord(emp.empName).toUpperCase();

  if (!nick) {
    // Nothing to derive from -- an empty/missing Name.
    console.log(`SKIP     ${label}`);
    console.log(`           no name to derive a nick name from`);
    noName++;
    continue;
  }

  if (existing && !OVERWRITE) {
    skipped++;
    continue;
  }

  if (existing === nick) {
    // Already correct (only reachable under --overwrite) -- no write needed.
    skipped++;
    continue;
  }

  console.log(`FILL     ${label}`);
  console.log(`           ${existing ? `"${existing}" -> ` : ""}"${nick}"`);
  if (APPLY) await Employee.updateOne({ _id: emp._id }, { $set: { empNickName: nick } });
  filled++;
}

console.log(`\n--- Summary ---`);
console.log(`Filled:   ${filled}`);
console.log(`Skipped:  ${skipped}${OVERWRITE ? " (already matching)" : " (nick name already set)"}`);
console.log(`No name:  ${noName}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await Employee.db.close();
process.exit(0);
