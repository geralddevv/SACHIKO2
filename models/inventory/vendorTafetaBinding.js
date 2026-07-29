import mongoose from "mongoose";

const vendorTafetaBindingSchema = new mongoose.Schema(
  {
    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      required: true,
      index: true,
    },
    tafetaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tafeta",
      required: true,
      index: true,
    },
    vendorTafetaMaterialCode: { type: String, required: true, trim: true },
    vendorTafetaMaterialType: { type: String, trim: true },
    vendorTafetaGsm: { type: String, trim: true },
    // Location this binding belongs to (one of the vendor user's locationDetails).
    location: { type: String, required: true, trim: true },
    tafetaMtrsDel: { type: String, trim: true },
    tafetaRatePerRoll: { type: Number, min: 0 },
    tafetaSaleCost: { type: Number, min: 0 },
    tafetaMinQty: { type: Number, required: true, min: 0 },
    tafetaOdrQty: { type: Number, min: 0 },
    tafetaOdrFreq: { type: String, trim: true },
    tafetaCreditTerm: { type: String, trim: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

vendorTafetaBindingSchema.index({ vendorUserId: 1, tafetaId: 1, vendorTafetaMaterialCode: 1, tafetaMinQty: 1, location: 1 }, { unique: true });

const VendorTafetaBinding = mongoose.model("VendorTafetaBinding", vendorTafetaBindingSchema);
export default VendorTafetaBinding;
