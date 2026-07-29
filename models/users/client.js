import mongoose from "mongoose";

let clientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  clientName: { type: String, required: true },
  clientType: { type: String, required: true },
  clientStatus: { type: String, required: true },
  hoLocation: { type: String, required: true },
  accountHead: { type: String, required: true },
  // ownerName: { type: String, required: true },
  // ownerMobNo: { type: String, required: true },
  // ownerEmail: { type: String, required: true },
  clientGst: { type: String, required: true },
  clientMsme: { type: String, required: true },
  clientGumasta: { type: String, required: true },
  clientPan: { type: String, required: true },
  vendorCode: { type: String, trim: true, default: "" },
  verticals: { type: String, trim: true, default: "" },
  clientSignature: { type: String, unique: true, sparse: true, trim: true },
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: "Username" }],
});
let Client = mongoose.model("Client", clientSchema);

export default Client;
