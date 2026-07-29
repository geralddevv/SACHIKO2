import mongoose from "mongoose";

const vendorPosRollBindingSchema = new mongoose.Schema(
  {
    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      required: true,
      index: true,
    },
    posRollId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PosRoll",
      required: true,
      index: true,
    },
    vendorPosPaperCode: { type: String, required: true, trim: true },
    vendorPosPaperType: { type: String, trim: true },
    vendorPosGsm: { type: Number, required: true },
    // Location this binding belongs to (one of the vendor user's locationDetails).
    location: { type: String, required: true, trim: true },
    posMtrsDel: { type: Number, default: 0 },
    posRatePerRoll: { type: Number },
    posSaleCost: { type: Number },
    posMinQty: { type: Number, required: true },
    posOdrQty: { type: Number },
    posOdrFreq: { type: String, trim: true },
    posCreditTerm: { type: String, trim: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

vendorPosRollBindingSchema.index(
  {
    vendorUserId: 1,
    posRollId: 1,
    vendorPosPaperCode: 1,
    vendorPosGsm: 1,
    posMinQty: 1,
    location: 1,
  },
  { unique: true },
);

const VendorPosRollBinding = mongoose.model("VendorPosRollBinding", vendorPosRollBindingSchema);
export default VendorPosRollBinding;
