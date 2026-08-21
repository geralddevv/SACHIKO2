import mongoose from "mongoose";

// One doc = one physical reel of raw Adhesive material. Generic raw-material
// inventory (see facestockStock.js for the fuller comment) -- its Type/Vendor/
// Make/Vendor SKU Code/Viscosity/Cohesion/Shear/Density are
// entered directly at inward, smart-filtered against Adhesive Master (see
// routes/stock/adhesiveStock.js's /filter-specs) so every field here mirrors
// one on models/inventory/adhesiveMaster.js. GSM is the one exception --
// Adhesive Master carries no gsm field, so it stays a plain typed value here.
const adhesiveStockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },
    gsm: {
      type: Number,
    },
    // The vendor who supplied this specific drum -- same Vendor master
    // (filtered to commodities: "ADHESIVE") and vendorId/vendorName
    // denormalization pairing used by Adhesive Master.
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
    // against the vendor's paperwork, same as Adhesive Master's own field.
    vendorSkuCode: {
      type: String,
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
    // System-generated ADHESIVE/YY-YY/NNN -- see utils/materialRollId.js.
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
    // Drum-specific quality details supplied at inward.
    joint: {
      type: String,
      trim: true,
    },
    wrinkle: {
      type: String,
      trim: true,
    },
    invoiceNo: {
      type: String,
      trim: true,
    },
    // Date the drum actually arrived/was invoiced -- defaults to today at
    // inward but editable so a delayed data entry can be backdated. Distinct
    // from createdAt, which always reflects when the record was saved.
    inwardDate: {
      type: Date,
    },
    remarks: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

adhesiveStockSchema.index({ type: 1, location: 1 });

export default mongoose.models.AdhesiveStock || mongoose.model("AdhesiveStock", adhesiveStockSchema);
