import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";

// ---------------------------------------------------------------------------
// Backfill for SachikoLabelStock's facestock/facestock2/adhesive/adhesive2/
// releaseLiner/releaseLiner2 sub-docs -- some of these fields (Facestock's
// Size, Adhesive's Viscosity/Cohesion/Shear/Density, Release Liner's Vendor
// SKU Code/Size) weren't captured at all until they were added to the form
// (see the comments on those fields in models/sachiko/sachikoLabelStock.js),
// so older rows are missing them even though the matching Facestock/Adhesive/
// Release Master row already has a value.
//
// For each layer, this "rebinds" it to whichever Master row its OWN
// currently-set fields already narrow down to (the exact same field list the
// Edit dialog's smart-filter cascade uses -- see FS_ORDER/AD_ORDER/RL_ORDER
// in views/sachiko/labelStockView.ejs), then fills in any of that layer's
// still-blank fields, but ONLY when every matching Master row agrees on the
// same value for that field. It never guesses between disagreeing candidates,
// and it never overwrites a field that already has a value.
//
// A field that stays unresolved (the matched rows disagree, or no Master row
// matches the layer's known fields at all) gets explicitly marked "None"
// instead of being left as a bare missing key -- "" for a String field, null
// for a Number one. That's a deliberate value the Edit dialog's cascade
// already understands as FS_NONE / "-- None --" (see fsDesiredValue in
// labelStockView.ejs), as opposed to an absent key, which that same code
// treats as "unconstrained/unknown". vendorId is the one field never marked
// this way -- it isn't part of the FS_NONE mechanism in the UI (an unset
// vendor is just left unconstrained there too), and it's an ObjectId ref, not
// a String/Number.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/rebind-labelstock-master-fields.js           # preview
//   node scripts/rebind-labelstock-master-fields.js --apply   # commit
// ---------------------------------------------------------------------------

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}
function canonStr(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function canonNum(v) {
  return isBlank(v) ? "" : String(Number(v));
}

// Mirrors FS_ORDER/AD_ORDER/RL_ORDER in views/sachiko/labelStockView.ejs --
// keep both in step. adhesiveGsm is deliberately excluded: Adhesive Master
// has no GSM field of its own (it's a plain typed number on the label stock,
// same as the view's own comment notes), so it can't be resolved from a
// Master match.
//
// Facestock/Release Liner Size and Adhesive Shelf Life are deliberately
// excluded entirely -- removed from the Edit dialog's form and cascade too
// (see FS_ORDER/AD_ORDER/RL_ORDER there). Several real Master rows can share
// every other identity field and differ only in Size, or in Shelf Life
// having drifted stale, either of which used to turn an otherwise-clean
// match into "no match"/"ambiguous" for every other field in the same card.
const LAYER_KINDS = {
  FACESTOCK: {
    label: "Facestock",
    Model: FacestockMaster,
    numeric: new Set(["gsm", "micron"]),
    fieldMap: {
      family: "facestockFamily",
      type: "facestockType",
      make: "facestockMake",
      vendorId: "facestockVendorId",
      vendorSkuCode: "facestockVendorSkuCode",
      gsm: "facestockGsm",
      micron: "facestockMicron",
    },
  },
  ADHESIVE: {
    label: "Adhesive",
    Model: AdhesiveMaster,
    numeric: new Set(["viscosity", "cohesion", "shear", "density"]),
    fieldMap: {
      type: "adhesiveType",
      make: "adhesiveMake",
      vendorId: "adhesiveVendorId",
      vendorSkuCode: "adhesiveVendorSkuCode",
      viscosity: "adhesiveViscosity",
      cohesion: "adhesiveCohesion",
      shear: "adhesiveShear",
      density: "adhesiveDensity",
    },
  },
  RELEASE: {
    label: "Release Liner",
    Model: ReleaseMaster,
    numeric: new Set(["gsm"]),
    fieldMap: {
      type: "releaseLinerType",
      make: "releaseLinerMake",
      vendorId: "releaseLinerVendorId",
      vendorSkuCode: "releaseLinerVendorSkuCode",
      color: "releaseLinerColor",
      gsm: "releaseLinerGsm",
    },
  },
};

// doc.facestock2/adhesive2/releaseLiner2 use the exact same field names as
// doc.facestock/adhesive/releaseLiner (the "2" only lives on the sub-doc key,
// see models/sachiko/sachikoLabelStock.js) -- one fieldMap per kind covers
// both slots.
const LAYER_SLOTS = [
  { key: "facestock", kind: "FACESTOCK", isLayer2: false },
  { key: "facestock2", kind: "FACESTOCK", isLayer2: true },
  { key: "adhesive", kind: "ADHESIVE", isLayer2: false },
  { key: "adhesive2", kind: "ADHESIVE", isLayer2: true },
  { key: "releaseLiner", kind: "RELEASE", isLayer2: false },
  { key: "releaseLiner2", kind: "RELEASE", isLayer2: true },
];

function fieldsMatch(genericKey, masterRow, knownCanon, numericSet) {
  if (genericKey === "vendorId") return String(masterRow.vendorId ?? "") === knownCanon;
  const rv = masterRow[genericKey];
  if (isBlank(rv)) return false;
  return (numericSet.has(genericKey) ? canonNum(rv) : canonStr(rv)) === knownCanon;
}

const APPLY = process.argv.includes("--apply");

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

// Loaded once per kind, filtered in memory per layer below -- these
// collections are small catalogs, not stock tables, so this is cheap and
// keeps the match logic identical to (and easy to compare against) the
// client-side cascade in labelStockView.ejs.
for (const kind of Object.values(LAYER_KINDS)) {
  kind.pool = await kind.Model.find().lean();
}

const docs = await SachikoLabelStock.find().lean();

function noneValue(cfg, g) {
  return cfg.numeric.has(g) ? null : "";
}

let layersEmpty = 0;
let layersNoMatch = 0;
let layersAlreadyComplete = 0;
let layersFilled = 0;
let fieldsFilled = 0;
let fieldsNoned = 0;
let docsChanged = 0;

for (const doc of docs) {
  const setOps = {};
  const lines = [];

  for (const slot of LAYER_SLOTS) {
    const layer = doc[slot.key];
    if (!layer) continue;
    const cfg = LAYER_KINDS[slot.kind];
    const genericKeys = Object.keys(cfg.fieldMap);
    const layerLabel = `${cfg.label}${slot.isLayer2 ? " (Layer 2)" : ""}`;

    const hasAny = genericKeys.some((g) => !isBlank(layer[cfg.fieldMap[g]]));
    if (!hasAny) { layersEmpty++; continue; }

    const known = {};
    for (const g of genericKeys) {
      const raw = layer[cfg.fieldMap[g]];
      if (isBlank(raw)) continue;
      known[g] = g === "vendorId" ? String(raw) : (cfg.numeric.has(g) ? canonNum(raw) : canonStr(raw));
    }

    const blankKeys = genericKeys.filter((g) => !(g in known) && g !== "vendorId");
    const pool = cfg.pool.filter((m) => Object.entries(known).every(([g, v]) => fieldsMatch(g, m, v, cfg.numeric)));

    if (pool.length === 0) {
      layersNoMatch++;
      if (blankKeys.length) {
        for (const g of blankKeys) {
          setOps[`${slot.key}.${cfg.fieldMap[g]}`] = noneValue(cfg, g);
          fieldsNoned++;
        }
        lines.push(`  ${layerLabel}: no ${cfg.label} Master row matches {${Object.keys(known).join(", ")}} -- marking ${blankKeys.join(", ")} as None.`);
      } else {
        lines.push(`  ${layerLabel}: no ${cfg.label} Master row matches {${Object.keys(known).join(", ")}} -- nothing blank to mark.`);
      }
      continue;
    }

    if (blankKeys.length === 0) { layersAlreadyComplete++; continue; }

    const fills = {};
    const stillBlank = [];
    for (const g of blankKeys) {
      const raws = pool.map((m) => m[g]);
      if (raws.some(isBlank)) { stillBlank.push(g); continue; }
      const canon = raws.map((r) => (cfg.numeric.has(g) ? canonNum(r) : canonStr(r)));
      if (new Set(canon).size !== 1) { stillBlank.push(g); continue; }
      fills[g] = raws[0];
    }

    if (Object.keys(fills).length > 0) {
      layersFilled++;
      for (const [g, v] of Object.entries(fills)) {
        setOps[`${slot.key}.${cfg.fieldMap[g]}`] = v;
        fieldsFilled++;
        lines.push(`  ${layerLabel}: ${cfg.fieldMap[g]} <- ${JSON.stringify(v)}  (${pool.length} matching Master row(s) agree)`);
      }
    }
    if (stillBlank.length) {
      for (const g of stillBlank) {
        setOps[`${slot.key}.${cfg.fieldMap[g]}`] = noneValue(cfg, g);
        fieldsNoned++;
      }
      lines.push(`  ${layerLabel}: ${stillBlank.join(", ")} still disagree/blank across the ${pool.length} matching row(s) -- marking as None.`);
    }
  }

  if (Object.keys(setOps).length > 0) {
    docsChanged++;
    console.log(`${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU code)"} (_id ${doc._id})`);
    lines.forEach((l) => console.log(l));
    if (APPLY) await SachikoLabelStock.updateOne({ _id: doc._id }, { $set: setOps });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Label Stocks checked:         ${docs.length}`);
console.log(`Documents with a change:      ${docsChanged}`);
console.log(`Fields filled from Master:    ${fieldsFilled}`);
console.log(`Fields marked None:           ${fieldsNoned}`);
console.log(`Layers filled (>=1 field):    ${layersFilled}`);
console.log(`Layers already complete:      ${layersAlreadyComplete}`);
console.log(`Layers with no Master match:  ${layersNoMatch}`);
console.log(`Layers empty/unused:          ${layersEmpty}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await SachikoLabelStock.db.close();
process.exit(0);
