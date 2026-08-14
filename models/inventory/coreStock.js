import mongoose from "mongoose";

// One doc = one inward lot of raw Core material (the tube a reel is wound
// on). Unlike Facestock/Adhesive/Release Liner, a core has no continuous
// "length" to draw down -- it's a discrete piece count -- so `quantity` here
// is the number of pieces still in this lot, not a fixed 0/1 reel flag. Its
// Type/Vendor/Make/Print Type/Thickness/Width are entered directly at
// inward, smart-filtered against Core Master (see
// routes/stock/coreStock.js's /filter-specs) so every field here mirrors one
// on models/inventory/coreMaster.js.
const coreStockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },
    // The vendor who supplied this specific lot -- same Vendor master
    // (filtered to commodities: "CORE") and vendorId/vendorName
    // denormalization pairing used by Core Master.
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
    // Printed vs. plain core surface.
    printType: {
      type: String,
      trim: true,
    },
    // Wall thickness in millimetres.
    thickness: {
      type: Number,
    },
    // Width in inches.
    width: {
      type: Number,
    },
    location: {
      type: String,
      required: true,
      index: true,
    },
    // Pieces still in this lot -- decremented only by editing the lot (no
    // scan/consume flow exists for cores; they aren't a Label Stock
    // production recipe layer the way Facestock/Adhesive/Release Liner are,
    // see models/sachiko/sachikoLabelStock.js).
    quantity: {
      type: Number,
      required: true,
    },
    rate: {
      type: Number,
    },
    // System-generated CORE/YY-YY/NNN -- see utils/materialRollId.js.
    rollId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },
    // The vendor's own batch/lot number, if any -- purely a cross-reference
    // against the vendor's paperwork, same as the other stock pools.
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

coreStockSchema.index({ type: 1, location: 1 });

export default mongoose.models.CoreStock || mongoose.model("CoreStock", coreStockSchema);
