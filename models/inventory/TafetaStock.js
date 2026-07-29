import mongoose from "mongoose";

const tafetaStockSchema = new mongoose.Schema(
  {
    tafeta: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tafeta",
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

// Fast lookup for balance aggregations per tafeta & location
tafetaStockSchema.index({ tafeta: 1, location: 1 });

/* ================= EXPORT ================= */
export default mongoose.models.TafetaStock || mongoose.model("TafetaStock", tafetaStockSchema);
