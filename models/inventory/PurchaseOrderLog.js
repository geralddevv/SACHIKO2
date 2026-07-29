import mongoose from "mongoose";

const purchaseOrderLogSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      required: true,
      index: true,
    },
    location: {
      type: String,
      trim: true,
      uppercase: true,
    },

    action: {
      type: String,
      enum: ["CREATED", "RECEIVED", "CANCELLED", "EDITED", "PARTIALLY_RECEIVED"],
      required: true,
    },

    poNumber: {
      type: String,
      trim: true,
    },

    quantity: {
      type: Number,
    },

    remarks: {
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

purchaseOrderLogSchema.index({ orderId: 1, performedAt: -1 });
purchaseOrderLogSchema.index({ action: 1, performedAt: -1 });

export default mongoose.models.PurchaseOrderLog || mongoose.model("PurchaseOrderLog", purchaseOrderLogSchema);
