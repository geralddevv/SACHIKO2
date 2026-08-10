import mongoose from "mongoose";

// One doc = one physical reel of raw Release Liner material. Generic
// raw-material inventory (see facestockStock.js for the fuller comment) --
// its Type/Color/GSM is entered directly at inward, same fields as the
// releaseLiner sub-schema on SachikoLabelStock, since Sachiko has no separate
// release liner master.
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
    gsm: {
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
