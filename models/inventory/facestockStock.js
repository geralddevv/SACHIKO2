import mongoose from "mongoose";

// One doc = one physical reel of raw Facestock material. Unlike MaterialStock
// (a reel of the finished, pre-laminated Label Stock matching one specific
// SachikoLabelStock SKU), this is generic raw-material inventory -- its own
// Family/Type/GSM/Micron/Vendor/Make/Vendor SKU Code is entered directly at
// inward (smart-filtered against Facestock Master -- see
// routes/stock/facestockStock.js's /filter-specs -- so every field here
// mirrors one on models/inventory/facestockMaster.js), rather than storing a
// reference to a master record the way PaperStock references Paper.
const facestockStockSchema = new mongoose.Schema(
  {
    family: {
      type: String,
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
    gsm: {
      type: Number,
    },
    micron: {
      type: Number,
    },
    // The vendor who supplied this specific reel -- same Vendor master
    // (filtered to commodities: "FACE PAPER") and vendorId/vendorName
    // denormalization pairing used by Facestock Master.
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
    },
    vendorName: {
      type: String,
      trim: true,
    },
    make: {
      type: String,
      trim: true,
    },
    // The vendor's own code for this spec -- purely a cross-reference
    // against the vendor's paperwork, same as Facestock Master's own field.
    vendorSkuCode: {
      type: String,
      trim: true,
    },
    location: {
      type: String,
      required: true,
      index: true,
    },
    // Rolls -- 1 at inward, or 0 once Label Stock Production
    // (routes/sachiko/labelStockProduction.js) empties the reel.
    quantity: {
      type: Number,
      required: true,
      default: 1,
    },
    reelMtrs: {
      type: Number,
      required: true,
    },
    rate: {
      type: Number,
    },
    // System-generated FACESTOCK/YY-YY/NNN -- see utils/materialRollId.js.
    rollId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },
    vendorRollId: {
      type: String,
      trim: true,
    },
    invoiceNo: {
      type: String,
      trim: true,
    },
    remarks: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

facestockStockSchema.index({ family: 1, type: 1, location: 1 });

export default mongoose.models.FacestockStock || mongoose.model("FacestockStock", facestockStockSchema);
