import mongoose from "mongoose";

const salesOrderLogSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TapeSalesOrder",
      required: true,
      index: true,
    },

    action: {
      type: String,
      enum: ["CREATED", "CONFIRMED", "CANCELLED", "DELIVERED"],
      required: true,
    },

    invoiceNumber: {
      type: String,
      trim: true,
    },

    quantity: {
      type: Number,
    },

    cancelReason: {
      type: String,
      trim: true,
    },

    performedBy: {
      type: String,
      default: "SYSTEM",
    },

    performedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// Fast retrieval for recent actions per order
salesOrderLogSchema.index({ orderId: 1, performedAt: -1 });
salesOrderLogSchema.index({ action: 1, performedAt: -1 });

export default mongoose.models.SalesOrderLog || mongoose.model("SalesOrderLog", salesOrderLogSchema);
