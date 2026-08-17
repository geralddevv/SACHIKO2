import mongoose from "mongoose";

// Core master -- a reusable catalog entry for a roll core spec (the tube a
// reel is wound on). Lives under the Masters tab alongside Facestock/
// Adhesive/Release.
const coreMasterSchema = new mongoose.Schema(
  {
    // System-generated "SP | COR | 000001", never user-edited.
    skuId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    // The vendor who supplies this core (Vendor master, filtered to
    // commodities: "CORE"). vendorName is a denormalized copy of
    // Vendor.vendorName for display without a populate, matching the
    // clientId/clientName pairing on models/users/username.js.
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    vendorName: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    make: {
      type: String,
      trim: true,
    },
    // Printed vs. plain core surface.
    printType: {
      type: String,
      required: true,
      trim: true,
    },
    // Wall thickness in millimetres.
    thickness: {
      type: Number,
      required: true,
    },
    // OD (Outer Diameter) in inches.
    od: {
      type: Number,
      required: true,
    },
    // Length in inches.
    length: {
      type: Number,
    },
    // Minimum Stock Quantity -- the reorder threshold for this core spec,
    // matching the "MSQ" field on the Tape vendor binding (tapeMinQty).
    // Purely an operational stock-control value, so it's not part of
    // coreSignature below.
    msq: {
      type: Number,
    },
    // Identifies "the exact same core spec" -- every field hashed together
    // (see buildCoreSignature in routes/system/coreMaster.js), so create/edit
    // is blocked only on a full duplicate, not a partial match. Sparse so
    // legacy rows without one don't collide with each other as "duplicates"
    // (see scripts/backfill-core-signatures.js).
    coreSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
  },
  { timestamps: true },
);

export default mongoose.models.CoreMaster || mongoose.model("CoreMaster", coreMasterSchema);
