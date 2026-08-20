import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import connectDB from "../config/db.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const APPLY = process.argv.includes("--apply");
const hashSignature = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const canonStr = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
const canonNum = (value) => (value === undefined || value === null || value === "" ? "" : String(Number(value)));
const signatureFor = (doc) => hashSignature([
  String(doc.vendorId || ""), canonStr(doc.type), canonStr(doc.make), canonStr(doc.vendorSkuCode),
  canonNum(doc.viscosity), canonNum(doc.cohesion), canonNum(doc.shear), canonNum(doc.density),
].join("||"));

await connectDB();
const masters = await AdhesiveMaster.find().lean();
const stale = masters.filter((master) => master.adhesiveSignature !== signatureFor(master));
const seen = new Map();
const collisions = [];
for (const master of masters) {
  const signature = signatureFor(master);
  if (seen.has(signature)) collisions.push([seen.get(signature), master]);
  else seen.set(signature, master);
}

console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`Adhesive Masters checked: ${masters.length}`);
console.log(`Needing a signature update: ${stale.length}`);
if (collisions.length) {
  console.error("No changes made: the revised identity would create duplicate Adhesive Masters.");
  collisions.forEach(([a, b]) => console.error(`  ${a.skuId} and ${b.skuId}`));
  await AdhesiveMaster.db.close();
  process.exit(1);
}

if (APPLY && stale.length) {
  await AdhesiveMaster.bulkWrite(stale.map((master) => ({
    updateOne: { filter: { _id: master._id }, update: { $set: { adhesiveSignature: signatureFor(master) } } },
  })));
}

console.log(APPLY ? "Signatures updated." : "Dry-run only. Re-run with --apply to commit.");
await AdhesiveMaster.db.close();
