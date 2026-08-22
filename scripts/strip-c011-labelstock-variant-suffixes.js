import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";

// ---------------------------------------------------------------------------
// Removes Label Stock sub-IDs / variant records for the C011 family:
//   (e.g., C011-A, C011-B, C011-C, C011-D, C011-E, or secondary C011 variants)
//
// The script keeps the primary base C011 record (SP | LS | 000004) and removes
// the sub-ID variant records from the database after verifying that no orders,
// bindings, or production records reference them.
//
// Dry-run by default:
//   node scripts/strip-c011-labelstock-variant-suffixes.js
//
// Apply (remove sub-IDs from database):
//   node scripts/strip-c011-labelstock-variant-suffixes.js --apply
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const BASE_PRODUCT_CODE = "C011";
const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "uploads", "sachiko", "label_stock");

function labelOf(doc) {
  return `${doc.productCode || "(no product code)"} / ${doc.skuCode || "(no SKU)"} / ${doc.labelStockId || "(no ID)"} (_id ${doc._id})`;
}

async function checkForeignReferences(db, docId) {
  const oId = new mongoose.Types.ObjectId(docId);
  const collections = await db.listCollections().toArray();
  const refs = [];

  for (const colMeta of collections) {
    if (colMeta.name === "labelstocks" || colMeta.name === "system.profile") continue;
    const col = db.collection(colMeta.name);
    const count = await col.countDocuments({
      $or: [
        { labelStock: oId },
        { labelStockId: oId },
        { itemId: oId },
        { labelStock_id: oId },
        { "layers.labelStockId": oId }
      ]
    });
    if (count > 0) {
      refs.push(`${colMeta.name} (${count} doc(s))`);
    }
  }
  return refs;
}

try {
  await connectDB();
  const db = mongoose.connection.db;

  // Find all C011 records (including C011, C011-A, C011-B, etc.)
  const allC011 = await SachikoLabelStock.find({
    $or: [
      { productCode: BASE_PRODUCT_CODE },
      { productCode: new RegExp(`^${BASE_PRODUCT_CODE}-[A-Z]+$`, "i") }
    ]
  })
    .sort({ createdAt: 1, labelStockId: 1 })
    .lean();

  console.log(`Mode: ${APPLY ? "APPLY (removing sub-IDs)" : "DRY-RUN (no changes)"}`);
  console.log(`Target: ${BASE_PRODUCT_CODE} family rows`);
  console.log(`Total C011 rows found: ${allC011.length}`);

  if (allC011.length <= 1) {
    console.log("\nOnly base C011 row exists (or none). Nothing to remove.");
    process.exit(0);
  }

  // Primary row is the base record (oldest / SP | LS | 000004)
  const baseDoc = allC011[0];
  const subRows = allC011.slice(1);

  console.log(`\nPrimary base row (KEEPING):`);
  console.log(`  ${labelOf(baseDoc)}`);

  console.log(`\nSub-ID / Variant rows (TO REMOVE):`);
  const safeToDelete = [];
  const blocked = [];

  for (const doc of subRows) {
    const refs = await checkForeignReferences(db, doc._id);
    if (refs.length > 0) {
      blocked.push({ doc, refs });
      console.log(`  [BLOCKED] ${labelOf(doc)} -> referenced in: ${refs.join(", ")}`);
    } else {
      safeToDelete.push(doc);
      console.log(`  [SAFE]    ${labelOf(doc)} -> no foreign references`);
    }
  }

  if (blocked.length > 0) {
    console.warn(`\nWarning: ${blocked.length} row(s) cannot be safely deleted due to foreign references.`);
  }

  if (!safeToDelete.length) {
    console.log("\nNo sub-ID rows are safe to remove.");
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDry-run preview complete. ${safeToDelete.length} sub-ID row(s) ready to be removed.`);
    console.log("Re-run with --apply to remove these rows from the database.");
    process.exit(0);
  }

  console.log("\nApplying changes...");
  for (const doc of safeToDelete) {
    await SachikoLabelStock.deleteOne({ _id: doc._id });

    // Clean up uploaded file if present
    if (doc.wordFile) {
      const filePath = path.join(UPLOAD_DIR, doc.wordFile);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn(`  Could not remove file ${doc.wordFile}: ${e.message}`);
        }
      }
    }
    console.log(`  ✓ Removed ${labelOf(doc)}`);
  }

  console.log(`\nSuccessfully removed ${safeToDelete.length} C011 sub-ID row(s).`);
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}

