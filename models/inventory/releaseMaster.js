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
    // The vendor who supplies this release liner (Vendor master, filtered to
    // commodities: "RELEASE PAPER"). vendorName is a denormalized copy of
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
    // The vendor's own code for this spec -- optional, purely a
    // cross-reference against the vendor's own paperwork.
    vendorSkuCode: {
      type: String,
      trim: true,
    },
    color: {
      type: String,
      trim: true,
      default: "WHITE",
    },
    size: {
      type: String,
      trim: true,
    },
    gsm: {
      type: Number,
    },
    // Minimum Stock Quantity -- the reorder threshold for this release
    // liner spec, matching the "MSQ" field on the Tape vendor binding
    // (tapeMinQty). Purely an operational stock-control value, so it's not
    // part of releaseSignature below.
    msq: {
      type: Number,
    },
    // Identifies "the exact same release liner spec" -- every field hashed
    // together (see buildReleaseSignature in routes/system/releaseMaster.js),
    // so create/edit is blocked only on a full duplicate, not a partial
    // match. Sparse so legacy rows without one don't collide with each
    // other as "duplicates" (see scripts/backfill-release-signatures.js).
    releaseSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
  },
  { timestamps: true },
);

export default mongoose.models.ReleaseMaster || mongoose.model("ReleaseMaster", releaseMasterSchema);
