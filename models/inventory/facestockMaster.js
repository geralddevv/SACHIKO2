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
    // The vendor who sells this facestock (Vendor master, filtered to
    // commodities: "FACE PAPER"). vendorName is a denormalized copy of
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
    family: {
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
    // facestockSignature below instead.
    vendorSkuCode: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    size: {
      type: String,
      trim: true,
    },
    // GSM and micron are mutually exclusive ways of specifying a facestock's
    // thickness -- the create/edit dialog disables whichever field is empty
    // once the other has a value, so a reel is described one way, not both.
    gsm: {
      type: Number,
    },
    micron: {
      type: Number,
    },
    // Identifies "the exact same facestock spec" -- every field hashed
    // together (see buildFacestockSignature in routes/system/facestockMaster.js),
    // so create/edit is blocked only on a full duplicate, not a partial
    // match. Sparse so legacy rows without one don't collide with each
    // other as "duplicates" (see scripts/backfill-facestock-signatures.js).
    facestockSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
  },
  { timestamps: true },
);

export default mongoose.models.FacestockMaster || mongoose.model("FacestockMaster", facestockMasterSchema);
