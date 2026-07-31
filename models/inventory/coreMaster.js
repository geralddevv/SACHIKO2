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
    skuCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    // Core inner diameter in inches -- same values as Tape's own
    // tapeCoreId (models/inventory/tape.js).
    size: {
      type: Number,
      enum: [0.5, 1, 2, 3],
    },
    mtrs: {
      type: Number,
    },
  },
  { timestamps: true },
);

export default mongoose.models.CoreMaster || mongoose.model("CoreMaster", coreMasterSchema);
