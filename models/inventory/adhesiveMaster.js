import mongoose from "mongoose";

// Adhesive master -- a reusable catalog entry for an adhesive spec (as
// opposed to models/inventory/adhesiveStock.js, which is a physical reel of
// stock). Lives under the Masters tab alongside Facestock/Core/Release.
const adhesiveMasterSchema = new mongoose.Schema(
  {
    // System-generated "SP | ADH | 000001", never user-edited.
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
    gsm: {
      type: Number,
    },
    mtrs: {
      type: Number,
    },
  },
  { timestamps: true },
);

export default mongoose.models.AdhesiveMaster || mongoose.model("AdhesiveMaster", adhesiveMasterSchema);
