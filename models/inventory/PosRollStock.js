import mongoose from "mongoose";

const posRollStockSchema = new mongoose.Schema(
  {
    posRoll: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PosRoll",
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
  },
  {
    timestamps: true,
  },
);

// Fast lookup for balance aggregations per posRoll & location
posRollStockSchema.index({ posRoll: 1, location: 1 });

/* ================= EXPORT ================= */
export default mongoose.models.PosRollStock || mongoose.model("PosRollStock", posRollStockSchema);
