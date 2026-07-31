import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import LabelStockBinding from "../models/sachiko/labelStockBinding.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import Label from "../models/inventory/labels.js";

// ---------------------------------------------------------------------------
// Deletes every Client except the one named FAIRTECH (exact match, trimmed,
// case-insensitive), along with everything that hangs off the removed
// clients: their Username (login) accounts, and everything those accounts
// own -- TapeSalesOrder, TapeBinding, LabelStockBinding, PendingProduction,
// and Label docs referenced from Username.label.
//
// Dry-run by default -- prints exactly what would be kept/deleted and does
// not touch the database. Pass --apply to actually commit the deletion.
//
//   node scripts/remove-clients-except-fairtech.js           # preview
//   node scripts/remove-clients-except-fairtech.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const KEEP_NAME = "FAIRTECH";

await connectDB();

const allClients = await Client.find({}).lean();

const keepClients = allClients.filter((c) => String(c.clientName || "").trim().toUpperCase() === KEEP_NAME);
const keepIds = new Set(keepClients.map((c) => String(c._id)));
const deleteClients = allClients.filter((c) => !keepIds.has(String(c._id)));

console.log(`Total clients found: ${allClients.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

if (keepClients.length === 0) {
  console.error(`ABORTING: no client found with clientName exactly "${KEEP_NAME}". Refusing to delete every client.`);
  await Client.db.close();
  process.exit(1);
}

console.log(`KEEP (${keepClients.length}):`);
for (const c of keepClients) {
  console.log(`  KEEP     ${c.clientName} (clientId ${c.clientId}, _id ${c._id})`);
}

if (deleteClients.length === 0) {
  console.log("\nNothing to delete -- every client already matches the keep list.");
  await Client.db.close();
  process.exit(0);
}

console.log(`\nDELETE (${deleteClients.length}):`);
for (const c of deleteClients) {
  console.log(`  DELETE   ${c.clientName} (clientId ${c.clientId}, _id ${c._id})`);
}

const deleteClientIds = deleteClients.map((c) => c._id);
const deleteClientBusinessIds = deleteClients.map((c) => c.clientId);

const usersToDelete = await Username.find({ clientId: { $in: deleteClientBusinessIds } })
  .select("_id userName clientName label")
  .lean();

const userIds = usersToDelete.map((u) => u._id);
const labelIds = usersToDelete.flatMap((u) => u.label || []);

const [tapeOrderCount, tapeBindingCount, labelStockBindingCount, pendingProductionCount, labelCount] = await Promise.all([
  TapeSalesOrder.countDocuments({ userId: { $in: userIds } }),
  TapeBinding.countDocuments({ userId: { $in: userIds } }),
  LabelStockBinding.countDocuments({ userId: { $in: userIds } }),
  PendingProduction.countDocuments({ userId: { $in: userIds } }),
  Label.countDocuments({ _id: { $in: labelIds } }),
]);

console.log(`\nCascade for the ${deleteClients.length} client(s) above:`);
console.log(`  Username accounts to delete:        ${usersToDelete.length}`);
for (const u of usersToDelete) {
  console.log(`    - ${u.userName} (client: ${u.clientName}, _id ${u._id})`);
}
console.log(`  TapeSalesOrder docs to delete:       ${tapeOrderCount}`);
console.log(`  TapeBinding docs to delete:          ${tapeBindingCount}`);
console.log(`  LabelStockBinding docs to delete:    ${labelStockBindingCount}`);
console.log(`  PendingProduction docs to delete:    ${pendingProductionCount}`);
console.log(`  Label docs to delete:                ${labelCount}`);

if (APPLY) {
  await TapeSalesOrder.deleteMany({ userId: { $in: userIds } });
  await TapeBinding.deleteMany({ userId: { $in: userIds } });
  await LabelStockBinding.deleteMany({ userId: { $in: userIds } });
  await PendingProduction.deleteMany({ userId: { $in: userIds } });
  await Label.deleteMany({ _id: { $in: labelIds } });
  await Username.deleteMany({ _id: { $in: userIds } });
  await Client.deleteMany({ _id: { $in: deleteClientIds } });
  console.log("\nChanges committed.");
} else {
  console.log("\nDry-run only. Re-run with --apply to commit.");
}

await Client.db.close();
process.exit(0);
