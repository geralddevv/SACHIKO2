import mongoose from "mongoose";

// Release Liner master -- a reusable catalog entry for a release liner spec
// (as opposed to models/inventory/releaseLinerStock.js, which is a physical
// reel of stock). Lives under the Masters tab alongside Facestock/Core/Adhesive.
const releaseMasterSchema = new mongoose.Schema(
  {
    // System-generated "SP | REL | 000001", never user-edited.
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
    color: {
      type: String,
      trim: true,
      default: "WHITE",
    },
    gsm: {
      type: Number,
    },
    mtrs: {
      type: Number,
    },
  },
  { timestamps: true },
);

export default mongoose.models.ReleaseMaster || mongoose.model("ReleaseMaster", releaseMasterSchema);
