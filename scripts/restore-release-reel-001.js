import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";

// ---------------------------------------------------------------------------
// Puts back Release Liner reel RELEASE/26-27/001, deleted from
// /sachiko/releaselinerstock on 2026-09-30, and removes RELEASE/26-27/126 --
// the same physical reel typed in again the next day (2026-10-01).
//
// Both are invoice TI-26, vendor roll 1, SCK / 660 mm / 67 GSM from
// P K TRADERS (002 -> 127, vendor roll 2, 339 kg, went the same way and is
// left alone). Restoring 001 without removing 126 would put vendor roll 1 on
// the shelf twice.
//
// The release liner Remove button is a hard delete, so 001 is restored from
// the 2026-09-23 morning backup (SP Bkup/sp-23-mrng). Its updatedAt there,
// 2026-09-19T11:18:58Z, is the reel's last audited edit before the delete, so
// it is the reel exactly as it was. It goes back under its ORIGINAL _id,
// createdAt and updatedAt -- written straight to the collection so mongoose's
// timestamps don't restamp it as new. The document is carried in this file
// rather than read from the backup, so it runs on a server that doesn't have
// the dump.
//
// Guards, so it can't remove the wrong thing or run twice:
//   - 126 is only removed if it is still the duplicate: same invoice, vendor
//     roll and spec as 001. Anything else and nothing is changed.
//   - 126 is only removed if nothing else in the database refers to it --
//     an order's allotment, a live job, a job card's usage, a Deckle's reels,
//     a swap log. Those references sit in many nested places, so this scans
//     every collection for the reel's _id and Roll ID rather than keeping a
//     list of fields that would go stale. The audit log is skipped (history,
//     not a link).
//   - Every check runs before anything is written, and each half recognises
//     itself as already done, so a re-run reports and changes nothing.
//
// The removed 126 is printed in full before it is deleted.
//
// Dry-run by default:
//   node scripts/restore-release-reel-001.js
// Apply:
//   node scripts/restore-release-reel-001.js --apply
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

// RELEASE/26-27/001 as it stood in SP Bkup/sp-23-mrng/sachiko/releaselinerstocks.bson.
const RESTORE_DOC = {
  _id: new mongoose.Types.ObjectId("6a857d0c6543673f4f6cbb43"),
  type: "SCK",
  color: "WHITE",
  size: "660",
  gsm: 67,
  vendorId: new mongoose.Types.ObjectId("6a34f2c5e584301f17545b7f"),
  vendorName: "P K TRADERS",
  make: "NA",
  vendorSkuCode: "SCK",
  location: "UNIT 2",
  quantity: 1,
  reelMtrs: 314,
  rate: 127,
  rollId: "RELEASE/26-27/001",
  vendorRollId: "1",
  invoiceNo: "TI-26",
  inwardDate: new Date("2026-05-19T00:00:00.000Z"),
  remarks: "",
  createdAt: new Date("2026-08-19T09:53:16.798Z"),
  updatedAt: new Date("2026-09-19T11:18:58.444Z"),
  __v: 0,
  sensing: "SENSING",
};

const DUPLICATE_ROLL_ID = "RELEASE/26-27/126";

// What makes 126 the same physical reel as 001.
const SAME_REEL_FIELDS = ["invoiceNo", "vendorRollId", "type", "size", "gsm", "vendorName"];

const SKIP_SCAN = new Set(["auditlogs", "releaselinerstocks"]);

function reelLabel(r) {
  return `${r.rollId}  _id ${r._id}  inv ${r.invoiceNo || "—"}  vendorRoll ${r.vendorRollId || "—"}  `
    + `${r.type} / ${r.size} mm / ${r.gsm} GSM  ${r.vendorName}  ${r.reelMtrs} kg  qty ${r.quantity}  `
    + `remarks "${r.remarks || ""}"`;
}

async function findReferences(reel) {
  const needles = [String(reel._id), reel.rollId];
  const hits = [];
  const db = mongoose.connection.db;
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (SKIP_SCAN.has(name) || name.startsWith("system.")) continue;
    for await (const doc of db.collection(name).find()) {
      const text = JSON.stringify(doc);
      if (needles.some((n) => text.includes(n))) hits.push(`${name} ${doc._id}`);
    }
  }
  return hits;
}

try {
  await connectDB();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN (no changes)"}`);
  console.log(`Database: ${mongoose.connection.name}\n`);

  // --- Restore 001 -------------------------------------------------------
  const byId = await ReleaseLinerStock.findById(RESTORE_DOC._id).lean();
  const byRollId = await ReleaseLinerStock.findOne({ rollId: RESTORE_DOC.rollId }).lean();

  let restoreNeeded = false;
  if (byId && byId.rollId === RESTORE_DOC.rollId) {
    console.log(`[DONE]    ${RESTORE_DOC.rollId} is already in stock: ${reelLabel(byId)}`);
  } else if (byId) {
    throw new Error(`_id ${RESTORE_DOC._id} is taken by ${byId.rollId}; nothing changed.`);
  } else if (byRollId) {
    throw new Error(`${RESTORE_DOC.rollId} already exists under another _id (${byRollId._id}); nothing changed.`);
  } else {
    restoreNeeded = true;
    console.log(`[RESTORE] ${reelLabel(RESTORE_DOC)}`);
  }

  // --- Remove 126 --------------------------------------------------------
  const dup = await ReleaseLinerStock.findOne({ rollId: DUPLICATE_ROLL_ID }).lean();

  let removeNeeded = false;
  if (!dup) {
    console.log(`[DONE]    ${DUPLICATE_ROLL_ID} is not in stock.`);
  } else {
    const mismatched = SAME_REEL_FIELDS.filter((f) => String(dup[f] ?? "") !== String(RESTORE_DOC[f] ?? ""));
    if (mismatched.length) {
      throw new Error(
        `${DUPLICATE_ROLL_ID} no longer looks like the same reel as ${RESTORE_DOC.rollId} `
        + `(differs on ${mismatched.join(", ")}): ${reelLabel(dup)}. Nothing changed.`,
      );
    }
    const refs = await findReferences(dup);
    if (refs.length) {
      throw new Error(
        `${DUPLICATE_ROLL_ID} is referenced elsewhere and can't be removed: ${refs.join("; ")}. Nothing changed.`,
      );
    }
    removeNeeded = true;
    console.log(`[REMOVE]  ${reelLabel(dup)}`);
  }

  if (!restoreNeeded && !removeNeeded) {
    console.log("\nNothing to do.");
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to make these changes.");
    process.exit(0);
  }

  console.log("\nApplying changes...");
  if (restoreNeeded) {
    await ReleaseLinerStock.collection.insertOne(RESTORE_DOC);
    console.log(`Restored ${RESTORE_DOC.rollId} (${RESTORE_DOC.reelMtrs} kg).`);
  }
  if (removeNeeded) {
    console.log(`Removing ${DUPLICATE_ROLL_ID}, which was:\n${JSON.stringify(dup, null, 2)}`);
    const result = await ReleaseLinerStock.deleteOne({ _id: dup._id });
    console.log(`Removed ${result.deletedCount} reel.`);
  }
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
