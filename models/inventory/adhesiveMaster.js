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
    // Free text, not a plain number: a vendor spec is routinely a RANGE
    // ("3000-5000"), so hyphens and spaces are allowed alongside digits.
    viscosity: {
      type: String,
      trim: true,
    },
    // Tackiness of the adhesive (peel/loop tack). Free text -- also often
    // quoted as a range or with a unit.
    tackiness: {
      type: String,
      trim: true,
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
    // Minimum Stock Quantity -- the reorder threshold for this adhesive
    // spec, matching the "MSQ" field on the Tape vendor binding
    // (tapeMinQty). Purely an operational stock-control value, so it's not
    // part of adhesiveSignature below.
    msq: {
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
