import mongoose from "mongoose";

const tapeStockSchema = new mongoose.Schema(
  {
    tape: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tape",
      required: true,
      index: true,
    },

    location: {
      type: String,
      required: true,
      index: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    remarks: {
      type: String,
      trim: true,
    },
    tapeFinish: {
      type: String,
      enum: ["MATTE", "GLOSSY", "CLEAR"],
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Fast lookup for balance aggregations per tape & location/finish
tapeStockSchema.index({ tape: 1, location: 1, tapeFinish: 1 });

/* ================= EXPORT ================= */
export default mongoose.models.TapeStock || mongoose.model("TapeStock", tapeStockSchema);
