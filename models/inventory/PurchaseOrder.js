import mongoose from "mongoose";

const purchaseOrderSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    onBindingModel: {
      type: String,
      enum: ["VendorTapeBinding", "VendorPosRollBinding", "VendorTafetaBinding", "VendorTtrBinding"],
    },
    vendorBinding: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "onBindingModel",
      index: true,
    },

    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      index: true,
    },

    onModel: {
      type: String,
      required: true,
      enum: ["Tape", "PosRoll", "Tafeta", "Ttr"],
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "onModel",
      required: true,
      index: true,
    },

    userLocation: {
      type: String,
      trim: true,
      uppercase: true,
    },

    /* ================= ORDER DETAILS ================= */
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    receivedQuantity: {
      type: Number,
      default: 0,
    },

    poNumber: {
      type: String,
      trim: true,
      required: true,
    },

    estimatedDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "RECEIVED", "PARTIALLY_RECEIVED", "CANCELLED"],
      default: "PENDING",
    },

    remarks: {
      type: String,
      trim: true,
    },

    /* ================= AUDIT ================= */
    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  {
    timestamps: true,
  },
);

purchaseOrderSchema.index({ itemId: 1, status: 1 });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });
purchaseOrderSchema.index({ vendorUserId: 1, status: 1 });

export default mongoose.models.PurchaseOrder || mongoose.model("PurchaseOrder", purchaseOrderSchema);
