import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import SachikoLabelStockModel from "../models/sachiko/sachikoLabelStock.js";
import CounterModel from "../models/system/counter.js";

// ---------------------------------------------------------------------------
// WIPES sachiko.labelstocks (the entire /sachiko/label-stock/view table --
// not just previously-migrated rows) and rebuilds it from scratch, using only
// FAIRTECH Paper Master rows (fairdesk.papers, /fairtech/paper/view) whose
// vendorName is SACHIKO PACKAGING. Every other vendor (Avery Dennison, MPS
// Industries, Zactac, Sticon, ...) is excluded entirely -- never read, never
// inserted. Read-only on the fairdesk side -- nothing is ever written or
// deleted there.
//
// The two schemas barely overlap -- Paper Master is a raw-material
// vendor/rate record, Label Stock is a facestock/adhesive/release-liner spec
// sheet -- so only the two fields that share real meaning are copied:
//
//   Paper.prodCode  -> LabelStock.productCode
//   Paper.family    -> LabelStock.facestock.facestockFamily
//
// Everything else on every row (Roll Type, FS/AD/RL GSM/Micron) is left at
// its schema default / blank for someone to fill in on
// /sachiko/label-stock/edit/:id. FS Type, AD Type and RL Type are `required`
// String fields whose required check rejects "" as well as null/undefined
// (SchemaString._checkRequired uses v.length), so there is no way to save
// them truly blank -- those three are seeded with the placeholder "TBD"
// instead, to fill in the same way. Vendor Name, Rate, Previous/Min/Max Rate,
// Status and Datasheet have no matching Label Stock column and are dropped
// entirely -- they are not recoverable from a Label Stock row.
//
// SAFETY: because this deletes every existing Label Stock row -- including
// ones never touched by this script, and any hand-entered FS/AD/RL detail
// filled in after a previous run -- --apply always dumps the full collection
// to scripts/backups/labelstocks-<timestamp>.json immediately before
// deleting anything. Nothing is deleted unless that dump succeeds first.
//
// Only ACTIVE Paper Master rows are imported by default -- pass
// --include-inactive to also pull INACTIVE ones.
//
// Dry-run by default -- prints exactly what would be deleted/inserted and
// does not touch either database. Pass --apply to commit.
//
//   node scripts/migrate-fairdesk-papers-to-label-stock.js                    # preview, ACTIVE only
//   node scripts/migrate-fairdesk-papers-to-label-stock.js --include-inactive # preview, all statuses
//   node scripts/migrate-fairdesk-papers-to-label-stock.js --apply           # commit, ACTIVE only
//
// Source defaults to a sibling "fairdesk" database on the same server as
// MONGO_URI (mirrors scripts/migrate-fairdesk-tapes.js); override with
// FAIRDESK_MONGO_URI if fairdesk lives elsewhere.
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const INCLUDE_INACTIVE = process.argv.includes("--include-inactive");
const NO_SOURCE_DATA = "TBD";
const VENDOR_FILTER = "SACHIKO PACKAGING";

function withAuth(uri) {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

// Points at a sibling "fairdesk" database on the same server/cluster as the
// main app -- same credentials, different database name.
function deriveFairdeskUri(mainUri) {
  const schemeSepIdx = mainUri.indexOf("//");
  if (schemeSepIdx === -1) return mainUri;

  const prefix = mainUri.slice(0, schemeSepIdx + 2);
  const afterScheme = mainUri.slice(schemeSepIdx + 2);
  const pathIdx = afterScheme.indexOf("/");
  if (pathIdx === -1) return `${prefix}${afterScheme}/fairdesk`;

  const hostPart = afterScheme.slice(0, pathIdx);
  const rest = afterScheme.slice(pathIdx + 1);
  const qIdx = rest.indexOf("?");
  const query = qIdx === -1 ? "" : rest.slice(qIdx);

  return `${prefix}${hostPart}/fairdesk${query}`;
}

const mainUri = process.env.MONGO_URI || "mongodb://localhost:27017/sachiko";
const sachikoUri = withAuth(mainUri);
const fairdeskUri = withAuth(process.env.FAIRDESK_MONGO_URI || deriveFairdeskUri(mainUri));

const sachikoConn = await mongoose.createConnection(sachikoUri).asPromise();
const fairdeskConn = await mongoose.createConnection(fairdeskUri).asPromise();
console.log(`Connected to sachiko (${sachikoConn.name}) and fairdesk (${fairdeskConn.name})\n`);

// Bind the real app schemas to these connections so defaults (rollType
// "NORMAL", releaseLinerColor "WHITE"), required checks and timestamps all
// behave exactly as they do through the app itself.
const SachikoLabelStock = sachikoConn.model("SachikoLabelStock", SachikoLabelStockModel.schema, "labelstocks");
const Counter = sachikoConn.model("Counter", CounterModel.schema, "counters");
const fairdeskPapers = fairdeskConn.collection("papers");

/* ================= ID generation (mirrors routes/sachiko/sachiko_route.js) ================= */
async function generateLabelStockId() {
  const counter = await Counter.findOneAndUpdate(
    { key: "sachikoLabelStockId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | LS | ${String(counter.seq).padStart(6, "0")}`;
}

const formatSkuCode = (n) => `SP | LS | ${String(n).padStart(6, "0")}`;
const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

async function generateSkuCode() {
  let nextSeq = parseSkuSeq((await SachikoLabelStock.findOne().sort({ skuCode: -1 }).select("skuCode").lean())?.skuCode) + 1;
  for (let i = 0; i < 10000; i++) {
    const candidate = formatSkuCode(nextSeq);
    if (!(await SachikoLabelStock.exists({ skuCode: candidate }))) return candidate;
    nextSeq += 1;
  }
  throw new Error("Unable to generate unique Label Stock SKU code");
}

/* ================= Load + dedupe source (SACHIKO PACKAGING only) ================= */
const query = {
  vendorName: { $regex: new RegExp(`^${VENDOR_FILTER}$`, "i") },
  ...(INCLUDE_INACTIVE ? {} : { status: { $ne: "INACTIVE" } }),
};
const sourcePapers = await fairdeskPapers.find(query).sort({ paperProductId: 1 }).toArray();

const trim = (v) => String(v ?? "").trim();
const dedupeKey = (prodCode, family) => `${trim(prodCode).toUpperCase()}::${trim(family).toUpperCase()}`;

const seen = new Map(); // dedupeKey -> first paper doc with that key
const duplicates = []; // papers dropped because an earlier row already covers the same (prodCode, family)
for (const p of sourcePapers) {
  const key = dedupeKey(p.prodCode, p.family);
  if (!key || key === "::") continue;
  if (seen.has(key)) {
    duplicates.push(p);
  } else {
    seen.set(key, p);
  }
}
const toInsert = [...seen.values()];

const existingCount = await SachikoLabelStock.countDocuments();

console.log(`fairdesk.papers, vendorName = "${VENDOR_FILTER}"${INCLUDE_INACTIVE ? "" : " (ACTIVE only -- pass --include-inactive for all)"}: ${sourcePapers.length} document(s)`);
console.log(`Distinct (Prod Code, Family) pairs: ${seen.size} (${duplicates.length} duplicate row(s) collapsed)`);
console.log(`sachiko.labelstocks currently holds ${existingCount} row(s) -- ALL of them will be deleted, not just ones from a previous migration run.`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

console.log(`Label Stock rows to insert after wipe (${toInsert.length}):`);
for (const p of toInsert) {
  console.log(`  INSERT  productCode="${trim(p.prodCode)}"  facestock.facestockFamily="${trim(p.family)}"  FS/AD/RL Type="${NO_SOURCE_DATA}"  (from Paper ${p.paperProductId})`);
}

if (APPLY) {
  console.log("");

  const backupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `labelstocks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const existingDocs = await SachikoLabelStock.find({}).lean();
  fs.writeFileSync(backupPath, JSON.stringify(existingDocs, null, 2));
  console.log(`Backed up ${existingDocs.length} existing row(s) to ${backupPath}`);

  const { deletedCount } = await SachikoLabelStock.deleteMany({});
  console.log(`Deleted ${deletedCount} row(s) from sachiko.labelstocks.`);

  for (const p of toInsert) {
    const labelStockId = await generateLabelStockId();
    const skuCode = await generateSkuCode();
    await SachikoLabelStock.create({
      labelStockId,
      skuCode,
      productCode: trim(p.prodCode),
      // facestockType/adhesiveType/releaseLinerType are `required: true`, and
      // this schema's String required check rejects "" as well as
      // null/undefined (SchemaString._checkRequired uses v.length) -- so
      // there is no way to actually save these blank. TBD is the closest
      // thing to "no data yet, fill in on /sachiko/label-stock/edit/:id".
      facestock: { facestockFamily: trim(p.family), facestockType: NO_SOURCE_DATA },
      adhesive: { adhesiveType: NO_SOURCE_DATA },
      releaseLiner: { releaseLinerType: NO_SOURCE_DATA },
      // family/rollOrSheet/printingTechnology are also `required: true` --
      // same TBD placeholder, same reason.
      family: NO_SOURCE_DATA,
      rollOrSheet: NO_SOURCE_DATA,
      printingTechnology: NO_SOURCE_DATA,
    });
    console.log(`  CREATED ${labelStockId}  ${skuCode}  productCode="${trim(p.prodCode)}"`);
  }
  console.log(`\nChanges committed. fairdesk.papers was not modified. Backup: ${backupPath}`);
} else {
  console.log(`\nDry-run only. Would delete ${existingCount} existing row(s) (backed up first) and insert ${toInsert.length} new row(s). Re-run with --apply to commit.`);
}

await sachikoConn.close();
await fairdeskConn.close();
process.exit(0);
