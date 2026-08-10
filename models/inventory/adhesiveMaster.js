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
    make: {
      type: String,
      trim: true,
    },
    // The vendor's own code for this spec -- not unique by itself (a vendor
    // can supply several distinct specs under the same code, or two vendors
    // can coincidentally use the same code); duplicate protection is by
    // adhesiveSignature below instead.
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
    // Identifies "the exact same adhesive spec" -- every field hashed
    // together (see buildAdhesiveSignature in routes/system/adhesiveMaster.js),
    // so create/edit is blocked only on a full duplicate, not a partial
    // match. Sparse so legacy rows without one don't collide with each
    // other as "duplicates" (see scripts/backfill-adhesive-signatures.js).
    adhesiveSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
  },
  { timestamps: true },
);

export default mongoose.models.AdhesiveMaster || mongoose.model("AdhesiveMaster", adhesiveMasterSchema);
