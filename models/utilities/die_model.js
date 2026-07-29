// models/die.model.js
import mongoose from "mongoose";

const DieSchema = new mongoose.Schema({
  dieDate: { type: Date, default: Date.now },
  dieType: { type: String, required: true },
  dieMake: { type: String, required: true },
  dieBladType: { type: String, required: true },
  dieMachineNo: { type: [String], required: true },
  dieDieNo:   { type: String, required: true },
  dieFamily:  { type: [String], required: true, validate: { validator: v => Array.isArray(v) && v.length > 0, message: "At least one family required" } },
  dieTeeth: { type: String, required: false }, // magteeth optional
  dieWidth: { type: String, required: true },
  dieHeight: { type: String, required: true },
  // The die tool's own manufactured dimensions, which can differ slightly
  // from the product Width/Height/Repeat Gap above (e.g. 12.5 vs 12).
  dieActualWidth: { type: String, required: false },
  dieActualHeight: { type: String, required: false },
  dieActualRepGap: { type: String, required: false },
  dieFlatAcrossGap: { type: String, required: true },
  dieFlatrepGap: { type: String, required: true },
  dieFlatAcross: { type: String, required: true },
  dieFlatDown: { type: String, required: true },
  dieTotalUps: { type: String, required: true },
  diePapType: { type: String, required: false },
  dieStatus: { type: String, required: true },
  dieOwnedBy: { type: String, required: true },
  dieClientName: { type: String, required: false }, // client name optional
  dieFlatRemark: { type: String, required: true },
  dieJpgFile: { type: String, required: false },
  dieDesignFile: { type: String, required: false },
  dieLayoutFile: { type: String, required: false },
  // Versioning: a damaged die gets replaced by a new die record with the same
  // specs. replacesDieId points back at the die this one supersedes; dieVersion
  // is that die's version + 1 (or 1 for an original, unversioned die).
  replacesDieId: { type: mongoose.Schema.Types.ObjectId, ref: "Die", required: false },
  dieVersion: { type: Number, required: true, default: 1 },
  // Physical/spec identity (NOT including dieDieNo/dieVersion) — deliberately
  // excludes the generated Die No so two dies with identical specs but
  // different numbers are still recognized as duplicates. Not a unique index:
  // a "Replace"/"New Version" record is expected to share its predecessor's
  // signature, so uniqueness is enforced in the route (which excludes the
  // die's own lineage) rather than at the DB level.
  dieSignature: { type: String, trim: true },
});

let Die = mongoose.model("Die", DieSchema);

export default Die;