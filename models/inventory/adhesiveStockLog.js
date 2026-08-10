import mongoose from "mongoose";

// Movement ledger mirroring AdhesiveStock -- see facestockStockLog.js for
// the fuller comment (same shape, same reasoning).
const adhesiveStockLogSchema = new mongoose.Schema(
  {
    location: {
      type: String,
      required: true,
      index: true,
    },
    openingStock: {
      type: Number,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    closingStock: {
      type: Number,
      required: true,
    },
    reelMtrs: {
      type: Number,
    },
    rate: {
      type: Number,
    },
    rollId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    vendorRollId: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["INWARD", "OUTWARD"],
      required: true,
    },
    source: {
      type: String,
      enum: ["MANUAL", "SYSTEM"],
      default: "MANUAL",
    },
    remarks: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  { timestamps: true },
);

export default mongoose.models.AdhesiveStockLog || mongoose.model("AdhesiveStockLog", adhesiveStockLogSchema);
