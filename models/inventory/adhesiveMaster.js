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
    // The vendor who supplies this adhesive (Vendor master, filtered to
    // commodities: "ADHESIVE"). vendorName is a denormalized copy of
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
    // The vendor's own code for this spec -- not globally unique (different
    // vendors can coincidentally use the same code), only unique per vendor
    // (see the compound index below).
    vendorSkuCode: {
      type: String,
      required: true,
      trim: true,
    },
    shelfLife: {
      type: String,
      required: true,
      trim: true,
    },
    viscosity: {
      type: Number,
    },
    cohesion: {
      type: Number,
    },
    shear: {
      type: Number,
    },
    density: {
      type: Number,
    },
  },
  { timestamps: true },
);

adhesiveMasterSchema.index({ vendorId: 1, vendorSkuCode: 1 }, { unique: true });

export default mongoose.models.AdhesiveMaster || mongoose.model("AdhesiveMaster", adhesiveMasterSchema);
