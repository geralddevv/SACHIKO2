import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Employee from "../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// Sets a known password on every shopfloor operator, so the operator portal
// and the Sachiko Operator mobile app can be signed into for testing.
//
// !! DEVELOPMENT / STAGING ONLY !!
// The whole point of this script is to make every operator account share one
// trivially-guessable password. Never run it against the live database: it
// would hand anyone who knows the convention a working login for all 12
// operators. It prints the database host it is about to write to before doing
// anything, and refuses to write unless --apply is passed -- read that line.
//
// Writes through doc.save(), NOT updateOne/findByIdAndUpdate. That matters:
// the bcrypt hashing lives in the Employee schema's pre("save") hook, which
// only fires on a document save. An update query would write the literal
// string "pass" into the password field, and comparePassword (bcrypt.compare)
// would then fail against it -- the accounts would look updated and silently
// refuse every login.
//
// Only active employees whose empProfile is OPERATOR are touched, since those
// are the only accounts the operator login will authenticate at all (see
// utils/operatorAuth.js).
//
// A password alone is not enough to log in: the operator login matches on
// NICK NAME + location + password, and an operator with a blank empNickName
// can never match. Pass --with-nicknames to also fill any blank nick name
// with the first word of the employee's name (what the HR form pre-fills).
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/set-operator-passwords.js                                  # preview
//   node scripts/set-operator-passwords.js --apply                          # commit
//   node scripts/set-operator-passwords.js --apply --with-nicknames         # + fill blank nick names
//   node scripts/set-operator-passwords.js --apply --password=somethingelse # different password
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const WITH_NICKNAMES = process.argv.includes("--with-nicknames");
const PASSWORD =
  (process.argv.find((a) => a.startsWith("--password=")) || "--password=pass").split("=").slice(1).join("=");

const nickFrom = (name) => String(name || "").trim().split(/\s+/)[0] || "";

async function run() {
  if (!PASSWORD) {
    console.error("A non-empty --password= value is required.");
    process.exit(1);
  }

  await connectDB();

  // Say plainly which database is about to be rewritten -- this is the one
  // check standing between a dev convenience and a production incident.
  const { host, port, name } = mongoose.connection;
  console.log(`\nTarget database : ${name} @ ${host}:${port}`);
  console.log(`Password to set : "${PASSWORD}"`);
  console.log(`Mode            : ${APPLY ? "APPLY (writing)" : "dry run (no writes)"}\n`);

  const operators = await Employee.find({ empProfile: "OPERATOR", isActive: true });
  if (!operators.length) {
    console.log("No active OPERATOR employees found -- nothing to do.");
    await mongoose.disconnect();
    return;
  }

  const blankNicks = operators.filter((e) => !String(e.empNickName || "").trim());

  console.log(`${operators.length} active operator(s):`);
  for (const emp of operators) {
    const nick = String(emp.empNickName || "").trim();
    const shownNick = nick || (WITH_NICKNAMES ? `${nickFrom(emp.empName)} (would set)` : "(BLANK - cannot log in)");
    console.log(`  ${emp.empName}`);
    console.log(`      nick: ${shownNick}   location: ${emp.empLoc || "-"}   machine: ${emp.empProfileCode || "-"}`);
  }

  if (!APPLY) {
    console.log(`\nDry run -- nothing written. Re-run with --apply to set the password.`);
    if (blankNicks.length && !WITH_NICKNAMES) {
      console.log(
        `Note: ${blankNicks.length} operator(s) have a blank nick name and still won't be able to log in.\n` +
          `      Add --with-nicknames to fill those from the first word of each name.`,
      );
    }
    await mongoose.disconnect();
    return;
  }

  let changed = 0;
  let nicksFilled = 0;
  for (const emp of operators) {
    emp.password = PASSWORD; // marks the path modified -> pre("save") bcrypts it
    if (WITH_NICKNAMES && !String(emp.empNickName || "").trim()) {
      const nick = nickFrom(emp.empName);
      if (nick) {
        emp.empNickName = nick;
        nicksFilled += 1;
      }
    }
    await emp.save();
    changed += 1;
  }

  console.log(`\nUpdated ${changed} operator password(s).`);
  if (WITH_NICKNAMES) console.log(`Filled ${nicksFilled} blank nick name(s).`);

  // Prove the round trip rather than trusting it: re-read one account and run
  // the same comparePassword the login does. Catches a future refactor that
  // swaps save() for an update query and quietly stores plaintext.
  const check = await Employee.findById(operators[0]._id);
  const ok = await check.comparePassword(PASSWORD);
  console.log(`Verify: comparePassword("${PASSWORD}") on ${check.empName} -> ${ok ? "OK" : "FAILED"}`);
  if (!ok) {
    console.error("Password did not verify -- accounts may now be unusable. Investigate before relying on this.");
    process.exitCode = 1;
  }

  const stillBlank = await Employee.countDocuments({
    empProfile: "OPERATOR",
    isActive: true,
    $or: [{ empNickName: { $exists: false } }, { empNickName: { $in: ["", null] } }],
  });
  if (stillBlank) {
    console.log(
      `\nHeads up: ${stillBlank} operator(s) still have a blank nick name and cannot log in.\n` +
        `Re-run with --with-nicknames, or set them on the HR > Employee form.`,
    );
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("SET OPERATOR PASSWORDS ERROR:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
