import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Empties the day-to-day data out of this company's database while leaving the
// masters, the raw-material stock and the people/permissions behind -- i.e. the
// state you want when a site has finished trialling and wants to start booking
// real work against the same catalogue.
//
//   node scripts/reset-transactional-data.js                        # preview
//   node scripts/reset-transactional-data.js --apply --db=<db name> # commit
//
// KEEP is keyed by the page each collection backs, so it can be checked against
// the app rather than taken on trust. Everything else in the database is
// emptied.
//
// Documents are removed with deleteMany, NOT dropCollection: the collections
// and every index on them survive, so the app behaves identically afterwards
// and nothing has to be re-created on next boot.
//
// Safety:
//   * dry run unless --apply, and --apply must be accompanied by --db=<name>
//     matching the database actually connected to (this is the guard against
//     pointing it at the wrong company);
//   * a collection the script has never heard of is NEVER emptied silently --
//     it is reported and blocks --apply until --allow-unknown says otherwise;
//   * take a mongodump first. This does not back anything up.
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const ALLOW_UNKNOWN = process.argv.includes("--allow-unknown");
const DB_ARG = (process.argv.find((a) => a.startsWith("--db=")) || "").slice(5);

// ---- KEEP: collection -> the page that reads it ---------------------------
// Every entry below was traced to the route that serves that URL (see
// CLAUDE.md's route table); change one only alongside the page it names.
const KEEP = {
  labelstocks: "/label-stock/view",
  clients: "/client/view",
  usernames: "/master/view",
  facestockstocks: "/facestockstock",
  adhesivestocks: "/adhesivestock",
  releaselinerstocks: "/releaselinerstock",
  corestocks: "/corestock",
  vendors: "/vendor/view",
  vendorusers: "/vendor/coordinator/view",
  companies: "/form/company",
  locations: "/form/location",
  machines: "/form/machine",
  facestockmasters: "/form/facestock",
  adhesivemasters: "/form/adhesive",
  releasemasters: "/form/release",
  families: "/form/family",
  types: "/form/type",
  coremasters: "/form/core",
  labelstockadhesivebindings: "/form/label-stock-adhesive-binding",
  employees: "/employee/view + /employee/admin/permissions",
  auditlogs: "/audit/view",

  // Not pages -- infrastructure that would break the kept data if it went.
  // counters holds the id sequences behind every kept master (labelStockId,
  // skuCode, clientId, ...). Reset it and the next save re-issues an id that
  // a surviving row already owns, which the unique indexes then reject.
  counters: "id sequences for the masters above",
  // Emptying this signs everyone out mid-reset for no gain.
  sessions: "logged-in sessions",
  // Schemaless system settings bucket.
  systemids: "system settings",
};

// ---- REMOVE: everything else, listed explicitly ---------------------------
// Split only to keep it readable; the script treats them identically.
const REMOVE_ORDERS_AND_PRODUCTION = [
  "tapesalesorders", "salesorders", "salesorderlogs",
  "pendingproductions", "machinejobcards", "slittingjobcards", "jobcards",
  "purchaseorders", "purchaseorderlogs",
  "finishedstocks", "finishedstocklogs",
  "materialstocks", "materialstocklogs",
  "samples", "maintenancerequests",
];
const REMOVE_STOCK_LOGS = [
  // History behind the stock pages that ARE kept: the reels survive, their
  // inward/outward trail does not.
  "facestockstocklogs", "adhesivestocklogs", "releaselinerstocklogs",
  "tapestocks", "tapestocklogs",
];
const REMOVE_BINDINGS_AND_ITEMS = [
  // Client<->product bindings, including Label Stock's. Rates, paper sizes and
  // RM per client go with them (the Label Stock *master* itself is kept).
  "labelstockbindings", "tapebindings", "vendortapebindings", "labels", "tapes",
];
const REMOVE_ACCOUNTING = [
  "payrolls", "payrolllogs", "loans", "loanlogs",
  "advances", "advancelogs", "pettycashes", "pettycashlogs",
];
const REMOVE_UTILITIES = ["blocks", "dies", "calculators"];
const REMOVE_LEGACY = [
  // No current model points at these -- leftovers from removed features and
  // from scripts/move-non-fairtech-clients-temp.js.
  "datasheets",
  "posrolls", "posrollstocks", "posrollstocklogs", "posrollbindings", "vendorposrollbindings",
  "tafetas", "tafetastocks", "tafetastocklogs", "tafetabindings", "vendortafetabindings",
  "temp_hidden_clients", "temp_hidden_usernames",
];

const REMOVE = new Set([
  ...REMOVE_ORDERS_AND_PRODUCTION,
  ...REMOVE_STOCK_LOGS,
  ...REMOVE_BINDINGS_AND_ITEMS,
  ...REMOVE_ACCOUNTING,
  ...REMOVE_UTILITIES,
  ...REMOVE_LEGACY,
]);

// ---- Dangling references on KEPT documents --------------------------------
// A kept document may hold ObjectIds into a collection that is being emptied.
// Left alone those become dead ids that populate() silently drops -- and, on
// the Sales Order form, a client that still looks bound to products that no
// longer exist. Each entry is only applied when its target is actually being
// emptied, so editing KEEP above cannot leave this out of step.
// ---- Partial delete inside a KEPT collection ------------------------------
// Label Stock variant rows ("C003FG-A", "C003FG-B", ...) are an internal
// production-time split of a base recipe (utils/labelStockVariant.js), minted
// automatically when a Deckle is produced. Nobody orders one -- /sales/order's
// own Product Code picker filters them out -- and this reset deletes every
// Deckle that created them, so leaving them behind would fill the catalogue
// with rows that have nothing behind them. The base rows are untouched.
//
// Matched on productCode, NOT skuCode. A variant's SKU normally mirrors its
// base row's ("SP | LS | 000003-A"), but buildVariantSkuCode() falls back to a
// plain sequence number when the base row can't be resolved -- on this data
// that is 4 rows (C003AC-A..D, SKUs "SP | LS | 000047".."000050") which a
// skuCode rule would silently leave behind. productCode carries the suffix in
// every case, and is what /sales/order, the paper re-order import and
// scripts/delete-labelstock-variant-and-stock.js all already filter on.
const VARIANT_PRODUCT_CODE = /-[A-Z]+$/;

// Everything else that can point at a Label Stock row -- material stock, label
// stock bindings, sales orders, pending production -- is emptied wholesale by
// this reset, so deleting a variant cannot orphan them. The one exception is
// labelstockadhesivebindings, which is KEPT: any of those sitting on a variant
// go with it, or the kept collection is left holding a dead reference.
//
// Files on disk (wordFile / pdfFile) are deliberately NOT removed: a variant
// can carry the same stored filename as the base row it was minted from, and
// deleting that would break the surviving base. An orphaned upload is
// harmless; a missing one is not.

const REFERENCE_CLEANUP = [
  { collection: "usernames", field: "label", pointsAt: "labels" },
  { collection: "usernames", field: "tape", pointsAt: "tapebindings" },
  { collection: "usernames", field: "labelStock", pointsAt: "labelstockbindings" },
  { collection: "vendorusers", field: "tape", pointsAt: "vendortapebindings" },
  { collection: "vendorusers", field: "label", pointsAt: "labels" },
];

const fmt = (n) => Number(n).toLocaleString("en-IN");
const pad = (s, n) => String(s).padEnd(n);

await connectDB();
const db = mongoose.connection.db;
const dbName = db.databaseName;

const present = (await db.listCollections().toArray())
  .map((c) => c.name)
  .filter((n) => !n.startsWith("system."))
  .sort();

const keep = present.filter((n) => KEEP[n]);
const remove = present.filter((n) => !KEEP[n] && REMOVE.has(n));
const unknown = present.filter((n) => !KEEP[n] && !REMOVE.has(n));

const counts = {};
for (const n of present) counts[n] = await db.collection(n).countDocuments();

console.log(`\nDatabase: ${dbName}`);
console.log(`Mode:     ${APPLY ? "APPLY (documents will be deleted)" : "DRY RUN (nothing will change)"}\n`);

console.log(`KEEP -- untouched (${keep.length}):`);
for (const n of keep) console.log(`  ${pad(n, 28)} ${pad(fmt(counts[n]), 9)} ${KEEP[n]}`);

const removeTotal = remove.reduce((n, c) => n + counts[c], 0);
console.log(`\nEMPTY -- every document deleted (${remove.length} collections, ${fmt(removeTotal)} documents):`);
for (const n of remove) {
  if (counts[n]) console.log(`  ${pad(n, 28)} ${fmt(counts[n])}`);
}
const emptyAlready = remove.filter((n) => !counts[n]);
if (emptyAlready.length) console.log(`  (already empty: ${emptyAlready.join(", ")})`);

// Variants live inside a kept collection, so they are counted and reported
// separately from the wholesale deletions above.
const variantFilter = { productCode: { $regex: VARIANT_PRODUCT_CODE } };
const variantDocs = present.includes("labelstocks")
  ? await db.collection("labelstocks").find(variantFilter, { projection: { skuCode: 1, productCode: 1 } }).toArray()
  : [];
const variantIds = variantDocs.map((d) => d._id);
const variantBindings = variantIds.length && present.includes("labelstockadhesivebindings")
  ? await db.collection("labelstockadhesivebindings").countDocuments({ labelStock: { $in: variantIds } })
  : 0;

if (variantDocs.length) {
  console.log(`\nPARTIAL -- rows removed from a KEPT collection (${fmt(variantDocs.length)}):`);
  console.log(`  ${pad("labelstocks", 28)} ${fmt(variantDocs.length)} variant row(s) of ${fmt(counts.labelstocks)} -- base products stay`);
  const show = variantDocs.slice(0, 6).map((d) => d.productCode).join(", ");
  console.log(`    ${show}${variantDocs.length > 6 ? `, +${variantDocs.length - 6} more` : ""}`);
  if (variantBindings) {
    console.log(`  ${pad("labelstockadhesivebindings", 28)} ${fmt(variantBindings)} binding(s) sitting on those variants`);
  }
}

if (unknown.length) {
  console.log(`\nUNRECOGNISED -- not in either list (${unknown.length}):`);
  for (const n of unknown) console.log(`  ${pad(n, 28)} ${fmt(counts[n])}`);
  console.log("  These are NOT touched unless --allow-unknown is passed. Classify them");
  console.log("  in this script (KEEP or REMOVE) rather than relying on that flag.");
}

console.log("\nConsequences worth reading before --apply:");
console.log("  * Client <-> product bindings go (labelstockbindings): every client loses");
console.log("    its per-product rate / paper size / RM. The Label Stock masters stay.");
console.log("  * The kept stock pages keep their reels but lose their inward/outward");
console.log("    history (the *stocklogs collections).");
console.log("  * Dies, blocks and calculators go with the production data.");
console.log("  * Label Stock VARIANT rows (\"C003FG-A\", ...) are deleted from the otherwise");
console.log("    kept catalogue -- they are minted per Deckle, and the Deckles are going.");

if (!APPLY) {
  console.log(`\nDry run only. To commit:\n  node scripts/reset-transactional-data.js --apply --db=${dbName}${unknown.length ? " --allow-unknown" : ""}`);
  console.log("Take a mongodump first -- this script does not back anything up.");
  await mongoose.connection.close();
  process.exit(0);
}

// ---- guards ---------------------------------------------------------------
if (DB_ARG !== dbName) {
  console.error(
    `\nREFUSED: --apply needs --db=${dbName} to confirm the target database` +
      (DB_ARG ? ` (got "${DB_ARG}").` : "."),
  );
  await mongoose.connection.close();
  process.exit(1);
}
if (unknown.length && !ALLOW_UNKNOWN) {
  console.error(
    `\nREFUSED: ${unknown.length} unrecognised collection(s) listed above.` +
      " Classify them in this script, or pass --allow-unknown to empty them anyway.",
  );
  await mongoose.connection.close();
  process.exit(1);
}

// ---- do it ----------------------------------------------------------------
const targets = ALLOW_UNKNOWN ? [...remove, ...unknown] : remove;
console.log("\nDeleting...");
let deleted = 0;
for (const n of targets) {
  if (!counts[n]) continue;
  const r = await db.collection(n).deleteMany({});
  deleted += r.deletedCount;
  console.log(`  ${pad(n, 28)} ${fmt(r.deletedCount)} deleted`);
}

console.log("\nClearing references on kept documents...");
for (const { collection, field, pointsAt } of REFERENCE_CLEANUP) {
  if (!targets.includes(pointsAt)) continue;       // its target survived
  if (!present.includes(collection)) continue;
  const r = await db.collection(collection).updateMany(
    { [field]: { $exists: true, $ne: [] } },
    { $set: { [field]: [] } },
  );
  if (r.modifiedCount) {
    console.log(`  ${pad(`${collection}.${field}`, 28)} cleared on ${fmt(r.modifiedCount)} doc(s) (pointed at ${pointsAt})`);
  }
}

if (variantDocs.length) {
  console.log("\nRemoving Label Stock variant rows...");
  // Bindings first: drop them while the ids they point at still exist, so a
  // failure part-way through can't leave a binding pointing at a deleted row.
  if (variantBindings) {
    const rb = await db.collection("labelstockadhesivebindings").deleteMany({ labelStock: { $in: variantIds } });
    deleted += rb.deletedCount;
    console.log(`  ${pad("labelstockadhesivebindings", 28)} ${fmt(rb.deletedCount)} deleted`);
  }
  const rv = await db.collection("labelstocks").deleteMany({ _id: { $in: variantIds } });
  deleted += rv.deletedCount;
  console.log(`  ${pad("labelstocks", 28)} ${fmt(rv.deletedCount)} variant row(s) deleted, ${fmt(counts.labelstocks - rv.deletedCount)} base product(s) left`);
}

console.log(`\nDone. ${fmt(deleted)} document(s) deleted from ${dbName}.`);
console.log("Collections and indexes were left in place.");

await mongoose.connection.close();
process.exit(0);
