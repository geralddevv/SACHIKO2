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
    // The vendor's own code for this spec -- unique per vendor (different
    // vendors can coincidentally use the same code), see the compound index
    // below.
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
    // GSM and micron are mutually exclusive ways of specifying a facestock's
    // thickness -- the create/edit dialog disables whichever field is empty
    // once the other has a value, so a reel is described one way, not both.
    gsm: {
      type: Number,
    },
    micron: {
      type: Number,
    },
  },
  { timestamps: true },
);

facestockMasterSchema.index({ vendorId: 1, vendorSkuCode: 1 }, { unique: true });

export default mongoose.models.FacestockMaster || mongoose.model("FacestockMaster", facestockMasterSchema);
