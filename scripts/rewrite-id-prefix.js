// ---------------------------------------------------------------------------
// Move every id from one company code to another: "SP | LS | 000003" ->
// "GM | LS | 000003".
//
// NOTHING NEEDS RUNNING FOR AN ORDINARY RENAME: changing the ID Code on the
// Company page already moves every id minted under the outgoing code
// (routes/system/company.js -> utils/idPrefixRewrite.js). This script is for
// the codes that rename never saw -- ids left behind by an earlier code, which
// are deliberately not touched when the company is renamed.
//
// Dry-run by default; it prints every field it would change and how many.
//
//   node scripts/rewrite-id-prefix.js --from SP --to GM
//   node scripts/rewrite-id-prefix.js --from SP --to GM --apply
//
// Stop the app first: ids are rewritten document by document, and a job card
// filed half way through would be stamped with the old code.
// ---------------------------------------------------------------------------
import "../config/loadEnv.js";
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import { rewriteIdPrefix, describeRewrite } from "../utils/idPrefixRewrite.js";
import { currentIdPrefix, refreshBrand } from "../utils/companyBrand.js";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : String(process.argv[i + 1] || "").trim().toUpperCase();
};
const APPLY = process.argv.includes("--apply");

await connectDB();
await refreshBrand();

const from = argOf("--from");
const to = argOf("--to") || currentIdPrefix();

if (!from) {
  console.error(`Usage: node scripts/rewrite-id-prefix.js --from <CODE> [--to ${currentIdPrefix()}] [--apply]`);
  await mongoose.disconnect();
  process.exit(1);
}
if (from === to) {
  console.error(`--from and --to are both "${from}" — nothing to move.`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`Moving ids: ${from} -> ${to}   (the company is minting ${currentIdPrefix()} right now)`);
console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no changes)"}\n`);

const result = await rewriteIdPrefix({ from, to, apply: APPLY });

const fields = Object.entries(result.byField).sort((a, b) => b[1] - a[1]);
if (fields.length) {
  console.log("Fields:");
  for (const [field, count] of fields) console.log(`  ${field.padEnd(40)} ${count}`);
  console.log();
}
if (result.collisions.length) {
  console.log(`Left alone — an id with that number already exists under ${to}:`);
  for (const c of result.collisions.slice(0, 20)) console.log(`  ${c.collection}.${c.path}  ${c.from} -> ${c.to}`);
  if (result.collisions.length > 20) console.log(`  ...and ${result.collisions.length - 20} more`);
  console.log();
}
console.log(describeRewrite(result));
console.log(`Not touched (history, never links): ${result.skipped.join(", ") || "none"}`);
if (!APPLY) console.log("\nDRY RUN — pass --apply to write it.");

await mongoose.disconnect();
