import mongoose from "mongoose";

// Facestock master -- a reusable catalog entry for a facestock spec (as
// opposed to models/inventory/facestockStock.js, which is a physical reel of
// stock). Lives under the Masters tab alongside Location/Machine.
const facestockMasterSchema = new mongoose.Schema(
  {
    // System-generated "SP | FCS | 000001", never user-edited.
    skuId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    family: {
      type: String,
      trim: true,
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

export default mongoose.models.FacestockMaster || mongoose.model("FacestockMaster", facestockMasterSchema);
