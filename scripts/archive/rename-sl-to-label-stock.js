import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../../config/db.js";
import Counter from "../../models/system/counter.js";

// ---------------------------------------------------------------------------
// One-time migration: rename "SL" to "Label Stock" all the way down to the
// database (this was itself the result of an earlier "Datasheet -> SL"
// migration, now being renamed again).
//
//   - collection "sls"                    -> "labelstocks"
//   - field      slId                     -> labelStockId (value format
//                                            "SP | SL | 000001" -> "SP | LS | 000001")
//   - field      skuCode value            "FS | SL | 000001" -> "FS | LS | 000001"
//   - collection "slbindings"             -> "labelstockbindings"
//   - field      slbindings.sl            -> labelStock
//   - field      usernames.sl             -> labelStock
//   - Counter doc key "sachikoSLId"       -> "sachikoLabelStockId" (keeps seq)
//   - tapesalesorders.onModel "SachikoSL" -> "SachikoLabelStock"
//   - tapesalesorders.onBindingModel "SLBinding" -> "LabelStockBinding"
//   - uploads/sachiko/sls/                -> uploads/sachiko/labelstocks/
//
// Dry-run by default. Pass --apply to commit.
//
//   node scripts/rename-sl-to-label-stock.js           # preview
//   node scripts/rename-sl-to-label-stock.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();
const db = mongoose.connection.db;

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const collections = (await db.listCollections().toArray()).map((c) => c.name);
const hasOldSL = collections.includes("sls");
const hasNewSL = collections.includes("labelstocks");
const hasOldBinding = collections.includes("slbindings");
const hasNewBinding = collections.includes("labelstockbindings");

if (!hasOldSL && !hasOldBinding) {
  console.log('Neither "sls" nor "slbindings" exist -- nothing to migrate (already renamed, or never created).');
  process.exit(0);
}

// Guard against overwriting real data in an already-vivified target
// collection (same situation handled in the earlier Datasheet->SL migration:
// the app itself can auto-create an empty target collection on startup via
// Mongoose's autoIndex once the new model/collection name is deployed).
async function checkTarget(oldName, newName, hasOld, hasNew) {
  if (!hasOld || !hasNew) return { autoVivified: false };
  const count = await db.collection(newName).countDocuments();
  if (count > 0) {
    console.error(`Both "${oldName}" and "${newName}" exist, and "${newName}" already has ${count} document(s) -- refusing to guess which is authoritative. Resolve manually before re-running.`);
    process.exit(1);
  }
  return { autoVivified: true };
}

const slTarget = await checkTarget("sls", "labelstocks", hasOldSL, hasNewSL);
const bindingTarget = await checkTarget("slbindings", "labelstockbindings", hasOldBinding, hasNewBinding);

const oldSLColl = hasOldSL ? db.collection("sls") : null;
const slDocCount = oldSLColl ? await oldSLColl.countDocuments() : 0;
const slIndexes = oldSLColl ? await oldSLColl.indexes() : [];
const oldSlIdIndex = slIndexes.find((i) => i.key && Object.keys(i.key).length === 1 && i.key.slId === 1 && i.name !== "_id_");

const oldBindingColl = hasOldBinding ? db.collection("slbindings") : null;
const bindingDocCount = oldBindingColl ? await oldBindingColl.countDocuments() : 0;

const usernamesWithSl = await db.collection("usernames").countDocuments({ sl: { $exists: true } });
const oldCounter = await Counter.findOne({ key: "sachikoSLId" }).lean();
const ordersToFix = await db.collection("tapesalesorders").countDocuments({
  $or: [{ onModel: "SachikoSL" }, { onBindingModel: "SLBinding" }],
});

const oldUploadDir = path.resolve("uploads/sachiko/sls");
const newUploadDir = path.resolve("uploads/sachiko/labelstocks");
const uploadFiles = fs.existsSync(oldUploadDir) ? fs.readdirSync(oldUploadDir) : [];

console.log(`Documents in "sls": ${slDocCount}${slTarget.autoVivified ? " (\"labelstocks\" already exists but empty -- auto-vivified by app startup, will be replaced)" : ""}`);
console.log(`Unique index on sls.slId: ${oldSlIdIndex ? oldSlIdIndex.name : "(none found)"}`);
console.log(`Documents in "slbindings": ${bindingDocCount}${bindingTarget.autoVivified ? " (\"labelstockbindings\" already exists but empty -- auto-vivified by app startup, will be replaced)" : ""}`);
console.log(`Username docs with an "sl" field: ${usernamesWithSl}`);
console.log(`Counter "sachikoSLId": ${oldCounter ? `seq=${oldCounter.seq}` : "(none found)"}`);
console.log(`tapesalesorders docs referencing old model names: ${ordersToFix}`);
console.log(`Word files in uploads/sachiko/sls: ${uploadFiles.length}`);

if (!APPLY) {
  console.log("\nDry-run only. Re-run with --apply to commit:");
  let step = 1;
  if (hasOldSL) {
    if (oldSlIdIndex) console.log(`  ${step++}. drop index "${oldSlIdIndex.name}" on sls`);
    console.log(`  ${step++}. rename collection "sls" -> "labelstocks"${slTarget.autoVivified ? " (replacing the empty auto-created one)" : ""}`);
    console.log(`  ${step++}. rename field slId -> labelStockId on ${slDocCount} document(s), rewriting "| SL |" -> "| LS |" in labelStockId and skuCode values`);
    console.log(`  ${step++}. create unique index on labelstocks.labelStockId`);
  }
  if (hasOldBinding) {
    console.log(`  ${step++}. rename collection "slbindings" -> "labelstockbindings"${bindingTarget.autoVivified ? " (replacing the empty auto-created one)" : ""}`);
    console.log(`  ${step++}. rename field sl -> labelStock on ${bindingDocCount} document(s)`);
  }
  if (usernamesWithSl > 0) console.log(`  ${step++}. rename field sl -> labelStock on ${usernamesWithSl} usernames document(s)`);
  if (oldCounter) console.log(`  ${step++}. rename Counter key sachikoSLId -> sachikoLabelStockId (seq=${oldCounter.seq})`);
  if (ordersToFix > 0) console.log(`  ${step++}. update ${ordersToFix} tapesalesorders doc(s): onModel SachikoSL -> SachikoLabelStock, onBindingModel SLBinding -> LabelStockBinding`);
  if (uploadFiles.length) console.log(`  ${step++}. move ${uploadFiles.length} file(s) from uploads/sachiko/sls -> uploads/sachiko/labelstocks`);
  process.exit(0);
}

// 1. SL master collection.
if (hasOldSL) {
  if (oldSlIdIndex) {
    await oldSLColl.dropIndex(oldSlIdIndex.name);
    console.log(`Dropped index "${oldSlIdIndex.name}"`);
  }

  await db.renameCollection("sls", "labelstocks", { dropTarget: true });
  console.log('Renamed collection "sls" -> "labelstocks"');

  const newSLColl = db.collection("labelstocks");

  const renameResult = await newSLColl.updateMany({}, { $rename: { slId: "labelStockId" } });
  console.log(`Renamed field slId -> labelStockId on ${renameResult.modifiedCount} document(s)`);

  // Rewrite the "| SL |" segment to "| LS |" in both id-style fields.
  const docsToFix = await newSLColl.find({}, { projection: { labelStockId: 1, skuCode: 1 } }).toArray();
  for (const doc of docsToFix) {
    const update = {};
    if (typeof doc.labelStockId === "string" && doc.labelStockId.includes("| SL |")) {
      update.labelStockId = doc.labelStockId.replace("| SL |", "| LS |");
    }
    if (typeof doc.skuCode === "string" && doc.skuCode.includes("| SL |")) {
      update.skuCode = doc.skuCode.replace("| SL |", "| LS |");
    }
    if (Object.keys(update).length > 0) {
      await newSLColl.updateOne({ _id: doc._id }, { $set: update });
    }
  }
  console.log(`Rewrote "| SL |" -> "| LS |" in labelStockId/skuCode across ${docsToFix.length} document(s)`);

  await newSLColl.createIndex({ labelStockId: 1 }, { unique: true });
  console.log("Created unique index on labelstocks.labelStockId");
}

// 2. Binding collection.
if (hasOldBinding) {
  await db.renameCollection("slbindings", "labelstockbindings", { dropTarget: true });
  console.log('Renamed collection "slbindings" -> "labelstockbindings"');

  const newBindingColl = db.collection("labelstockbindings");
  const bindingRenameResult = await newBindingColl.updateMany({}, { $rename: { sl: "labelStock" } });
  console.log(`Renamed field sl -> labelStock on ${bindingRenameResult.modifiedCount} document(s)`);
}

// 3. Username.sl -> Username.labelStock.
if (usernamesWithSl > 0) {
  const userRenameResult = await db.collection("usernames").updateMany(
    { sl: { $exists: true } },
    { $rename: { sl: "labelStock" } },
  );
  console.log(`Renamed field sl -> labelStock on ${userRenameResult.modifiedCount} usernames document(s)`);
}

// 4. Counter key.
if (oldCounter) {
  await Counter.updateOne({ key: "sachikoSLId" }, { $set: { key: "sachikoLabelStockId" } });
  console.log(`Renamed Counter key sachikoSLId -> sachikoLabelStockId (seq=${oldCounter.seq})`);
}

// 5. Existing sales orders referencing the old model names (should be none
// in practice, but handled for correctness/safety).
if (ordersToFix > 0) {
  const orderUpdateResult = await db.collection("tapesalesorders").updateMany(
    { onModel: "SachikoSL" },
    { $set: { onModel: "SachikoLabelStock" } },
  );
  const bindingModelUpdateResult = await db.collection("tapesalesorders").updateMany(
    { onBindingModel: "SLBinding" },
    { $set: { onBindingModel: "LabelStockBinding" } },
  );
  console.log(`Updated ${orderUpdateResult.modifiedCount} onModel + ${bindingModelUpdateResult.modifiedCount} onBindingModel value(s) on tapesalesorders`);
}

// 6. Move any uploaded word files across.
if (uploadFiles.length) {
  fs.mkdirSync(newUploadDir, { recursive: true });
  for (const file of uploadFiles) {
    fs.renameSync(path.join(oldUploadDir, file), path.join(newUploadDir, file));
  }
  console.log(`Moved ${uploadFiles.length} file(s) to uploads/sachiko/labelstocks`);
  try {
    fs.rmdirSync(oldUploadDir);
  } catch {
    // Non-empty or in use -- leave it, nothing critical depends on it being removed.
  }
}

console.log("\nMigration complete.");
await mongoose.connection.close();
process.exit(0);
