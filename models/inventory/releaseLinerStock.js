import mongoose from "mongoose";

// One doc = one physical reel of raw Release Liner material. Generic
// raw-material inventory (see facestockStock.js for the fuller comment) --
// its Type/Color/GSM/Vendor/Make/Vendor SKU Code is entered directly at
// inward, smart-filtered against Release Master (see
// routes/stock/releaseLinerStock.js's /filter-specs) so every field here
// mirrors one on models/inventory/releaseMaster.js.
const releaseLinerStockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
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
    // The vendor who supplied this specific reel -- same Vendor master
    // (filtered to commodities: "RELEASE PAPER") and vendorId/vendorName
    // denormalization pairing used by Release Master.
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
    // against the vendor's paperwork, same as Release Master's own field.
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
    // System-generated RELEASE/YY-YY/NNN -- see utils/materialRollId.js.
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

releaseLinerStockSchema.index({ type: 1, location: 1 });

export default mongoose.models.ReleaseLinerStock || mongoose.model("ReleaseLinerStock", releaseLinerStockSchema);
