// ---------------------------------------------------------------------------
// The URL prefixes this company has been served under.
//
// The prefix is the first word of the company name (slugifyCompany), so
// renaming the company moves the whole app to a new one -- /sachiko/... becomes
// /ryt/.... Every prefix in this list is forwarded to the current one by
// middleware/brandPrefix.js, so bookmarks and open tabs on an old address keep
// working instead of answering 404.
//
// NOTHING NEEDS RUNNING FOR AN ORDINARY RENAME. A rename through the Company
// page records the outgoing prefix itself (routes/system/company.js), and a
// database that predates that field seeds itself from the audit log on the
// next start (seedSlugHistory in utils/companyBrand.js), which knows every
// name the company has ever been saved under.
//
// This script is the manual override for what neither of those can know: a
// prefix that never appears in this database's own history -- one used on an
// earlier installation, or before the audit log was kept.
//
//   node scripts/company-slug-history.js                      # show
//   node scripts/company-slug-history.js --add sachiko        # preview
//   node scripts/company-slug-history.js --add sachiko --apply
//   node scripts/company-slug-history.js --remove sachiko --apply
// ---------------------------------------------------------------------------
import "../config/loadEnv.js";
import connectDB from "../config/db.js";
import Company from "../models/system/company.js";
import { slugifyCompany, INTERNAL_PREFIX } from "../utils/companyBrand.js";
import mongoose from "mongoose";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : String(process.argv[i + 1] || "").trim().toLowerCase();
};
const APPLY = process.argv.includes("--apply");
const add = argOf("--add");
const remove = argOf("--remove");

await connectDB();

const company = await Company.findOne({ singleton: "COMPANY" }).lean();
if (!company) {
  console.log("No company is registered yet — nothing to do.");
  await mongoose.disconnect();
  process.exit(0);
}

const current = slugifyCompany(company.companyName);
const history = Array.isArray(company.slugHistory) ? company.slugHistory : [];

console.log(`Company : ${company.companyName}`);
console.log(`Serving at: /${current}/`);
console.log(`Also forwarded from: ${history.length ? history.map((s) => `/${s}/`).join(", ") : "(nothing recorded)"}\n`);

if (!add && !remove) {
  await mongoose.disconnect();
  process.exit(0);
}

let next = [...history];
if (add) {
  if (!/^[a-z][a-z0-9]{0,30}$/.test(add)) {
    console.error(`"${add}" is not a usable prefix (letters and digits, starting with a letter).`);
    process.exit(1);
  }
  if (add === INTERNAL_PREFIX) {
    console.error(`"${add}" is the app's own internal mount and is always served — nothing to record.`);
    process.exit(1);
  }
  if (add === current) {
    console.error(`"${add}" is the prefix in use right now — it needs no forwarding.`);
    process.exit(1);
  }
  next = [...next.filter((s) => s !== add), add].slice(-5);
}
if (remove) next = next.filter((s) => s !== remove);

console.log(`${history.join(", ") || "(none)"}  ->  ${next.join(", ") || "(none)"}`);
if (!APPLY) {
  console.log("\nDRY RUN — pass --apply to write it.");
  await mongoose.disconnect();
  process.exit(0);
}

await Company.updateOne({ _id: company._id }, { $set: { slugHistory: next } });
console.log("\nSaved. It takes effect within a few seconds (the brand cache refreshes itself); restart the server to be sure.");
await mongoose.disconnect();
