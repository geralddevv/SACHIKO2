import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import FacestockStock from "../models/inventory/facestockStock.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MachineJobCard from "../models/inventory/machineJobCard.js";
import { pickStockIds } from "../utils/labelStockProduction.js";

// ---------------------------------------------------------------------------
// Removes a batch of FacestockStock reels that were re-entered under the
// WRONG Size after already being inwarded correctly -- e.g. a spec was
// inwarded at 510mm, then the same invoices were typed in again weeks later
// under 520mm (the real width), leaving 13 phantom reels sitting under 510mm
// that: (a) have no matching Facestock Master, so /sachiko/facestockstock
// never shows them at all, and (b) double-count real stock that already
// exists correctly at the other size.
//
// This is exactly the CHROMO / GLOSSY / HI-KOTE / 80 GSM / SHREE ASHTAVINAYAK
// PAPERS PVT LTD case found and fixed by hand on 2026-09-23 (510mm -> 520mm,
// 13 reels / 6,620 kg). The defaults below reproduce that fix; pass --family/
// --type/--make/--gsm/--micron/--vendor/--from-size/--to-size to reuse this
// for a different spec if the same mistake happens again.
//
// Only reels still in stock (quantity > 0) under --from-size are candidates
// -- a reel already drawn to 0 is history, not a duplicate, and is never
// touched regardless of size. Reels under --to-size are printed for
// side-by-side comparison only; they are never modified.
//
// Before deleting, each candidate reel is checked for live references --
// PendingProduction.allottedLayers (raw material picked for an open job),
// PendingProduction.liveMaterialInUse.facestock (mid-job, not yet saved), and
// MachineJobCard.facestockUsage (already consumed and recorded on a saved
// job card). A referenced reel is left alone and reported, never deleted --
// deleting it out from under a real job/log would orphan that reference.
//
// Dry-run by default:
//   node scripts/remove-duplicate-facestock-reels.js
//
// Apply (delete the unreferenced --from-size reels):
//   node scripts/remove-duplicate-facestock-reels.js --apply
//
// Different spec / sizes:
//   node scripts/remove-duplicate-facestock-reels.js \
//     --family CHROMO --type GLOSSY --make HI-KOTE --gsm 80 \
//     --vendor "SHREE ASHTAVINAYAK PAPERS PVT LTD" \
//     --from-size 510 --to-size 520 --apply
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return String(process.argv[i + 1] ?? "").trim();
};

const FAMILY = argOf("--family", "CHROMO");
const TYPE = argOf("--type", "GLOSSY");
const MAKE = argOf("--make", "HI-KOTE");
const GSM = argOf("--gsm", "80");
const MICRON = argOf("--micron", "");
const VENDOR = argOf("--vendor", "SHREE ASHTAVINAYAK PAPERS PVT LTD");
const FROM_SIZE = argOf("--from-size", "510");
const TO_SIZE = argOf("--to-size", "520");

function rowLabel(r) {
  return `${r.rollId}  inv ${r.invoiceNo || "—"}  vendorRoll ${r.vendorRollId || "—"}  ${r.reelMtrs} kg  inward ${
    r.inwardDate ? new Date(r.inwardDate).toISOString().slice(0, 10) : "—"
  }`;
}

// One pass over every open order + saved job card, building id -> reason
// maps -- same shape as loadFacestockReelUsage() in
// routes/stock/facestockStock.js, done once up front rather than re-querying
// per candidate reel.
async function buildReferenceMaps() {
  const pending = await PendingProduction.find({ producedAt: null })
    .select("allottedLayers liveMaterialInUse lotNo")
    .lean();

  const refsById = new Map();
  const addRef = (id, reason) => {
    const key = String(id);
    if (!refsById.has(key)) refsById.set(key, []);
    refsById.get(key).push(reason);
  };

  for (const p of pending) {
    for (const pick of Object.values(p.allottedLayers || {})) {
      if (pick?.pool !== "facestock") continue;
      for (const id of pickStockIds(pick)) addRef(id, `PendingProduction ${p.lotNo || p._id} (allotted)`);
    }
    for (const id of p.liveMaterialInUse?.facestock || []) {
      addRef(id, `PendingProduction ${p.lotNo || p._id} (live, not yet saved)`);
    }
  }

  const jobCards = await MachineJobCard.find({ "facestockUsage.0": { $exists: true } })
    .select("facestockUsage lotNo")
    .lean();
  for (const jc of jobCards) {
    for (const u of jc.facestockUsage || []) {
      if (u.stockId) addRef(u.stockId, `MachineJobCard ${jc.lotNo || jc._id} (saved usage)`);
    }
  }

  return refsById;
}

try {
  await connectDB();

  const specFilter = {
    family: FAMILY,
    type: TYPE,
    make: MAKE,
    gsm: Number(GSM),
    vendorName: VENDOR,
  };
  if (MICRON) specFilter.micron = Number(MICRON);

  console.log(`Mode: ${APPLY ? "APPLY (deleting)" : "DRY-RUN (no changes)"}`);
  console.log(`Spec: ${FAMILY} / ${TYPE} / ${MAKE} / ${GSM} GSM${MICRON ? ` / ${MICRON} micron` : ""} / ${VENDOR}`);
  console.log(`Comparing size ${FROM_SIZE} (candidate for removal) against size ${TO_SIZE} (kept as-is)\n`);

  const fromRows = await FacestockStock.find({ ...specFilter, size: FROM_SIZE, quantity: { $gt: 0 } })
    .sort({ rollId: 1 })
    .lean();
  const toRows = await FacestockStock.find({ ...specFilter, size: TO_SIZE, quantity: { $gt: 0 } })
    .sort({ rollId: 1 })
    .lean();

  console.log(`Size ${TO_SIZE} — ${toRows.length} reel(s), ${toRows.reduce((s, r) => s + (r.reelMtrs || 0), 0)} kg (reference, not touched):`);
  for (const r of toRows) console.log(`  ${rowLabel(r)}`);

  console.log(`\nSize ${FROM_SIZE} — ${fromRows.length} reel(s), ${fromRows.reduce((s, r) => s + (r.reelMtrs || 0), 0)} kg (candidates):`);
  if (!fromRows.length) {
    console.log(`  none — nothing to remove.`);
    process.exit(0);
  }

  const refsById = await buildReferenceMaps();
  const safeToDelete = [];
  const blocked = [];
  for (const r of fromRows) {
    const refs = refsById.get(String(r._id)) || [];
    if (refs.length) {
      blocked.push({ r, refs });
      console.log(`  [BLOCKED] ${rowLabel(r)} -> referenced in: ${refs.join(", ")}`);
    } else {
      safeToDelete.push(r);
      console.log(`  [SAFE]    ${rowLabel(r)}`);
    }
  }

  if (blocked.length) {
    console.warn(`\nWarning: ${blocked.length} reel(s) are referenced by live/saved production and will NOT be deleted.`);
  }

  const totalKg = safeToDelete.reduce((s, r) => s + (r.reelMtrs || 0), 0);
  console.log(`\n${safeToDelete.length} reel(s) / ${totalKg} kg are safe to delete.`);

  if (!safeToDelete.length) {
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to delete these reels.");
    process.exit(0);
  }

  console.log("\nApplying changes...");
  const result = await FacestockStock.deleteMany({ _id: { $in: safeToDelete.map((r) => r._id) } });
  console.log(`Deleted ${result.deletedCount} reel(s) totalling ${totalKg} kg.`);
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
