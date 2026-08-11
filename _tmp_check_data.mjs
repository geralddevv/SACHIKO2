import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const uri = process.env.MONGO_URI;
const user = process.env.MONGO_USER;
const pass = process.env.MONGO_PASS;
let finalUri = uri;
if (user && pass && finalUri.startsWith("mongodb://") && !finalUri.includes("@")) {
  finalUri = finalUri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
  if (!finalUri.includes("authSource")) {
    finalUri += (finalUri.includes("?") ? "&" : "?") + "authSource=admin";
  }
}
await mongoose.connect(finalUri);
const db = mongoose.connection.db;

const masterList = await db.collection("labelstocks").find().project({ skuCode: 1, productCode: 1 }).toArray();
console.log("=== SachikoLabelStock master (labelstocks collection) ===");
console.log("count:", masterList.length);
console.log(JSON.stringify(masterList, null, 2));

const bindings = await db.collection("labelstockbindings").find().toArray();
console.log("=== LabelStockBinding (labelstockbindings collection) ===");
console.log("count:", bindings.length);
console.log(JSON.stringify(bindings, null, 2));

await mongoose.disconnect();
