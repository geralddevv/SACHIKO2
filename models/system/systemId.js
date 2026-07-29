import mongoose from "mongoose";

let systemIdSchema = new mongoose.Schema({}, {strict: false});
let SystemId = mongoose.model("SystemId", systemIdSchema);

export default SystemId;