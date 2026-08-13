import mongoose from "mongoose";

// Movement ledger mirroring FinishedStock, same split as MaterialStock/
// MaterialStockLog: FinishedStock rows are the actual balance, this is the
// parallel audit trail with its own opening/closing snapshot.
const finishedStockLogSchema = new mongoose.Schema(
  {
    material: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SachikoLabelStock",
      required: true,
      index: true,
    },
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
    mtrs: {
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

export default mongoose.models.FinishedStockLog || mongoose.model("FinishedStockLog", finishedStockLogSchema);
