import mongoose from "mongoose";

const tapeSalesOrderSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    onBindingModel: {
      type: String,
      required: true,
      enum: ["TapeBinding", "PosRollBinding", "TafetaBinding", "TtrBinding", "LabelBinding", "Label"],
      default: "TapeBinding",
    },
    tapeBinding: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "onBindingModel",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Username",
      required: true,
      index: true,
    },

    onModel: {
      type: String,
      required: true,
      enum: ["Tape", "PosRoll", "Tafeta", "Ttr", "Label"],
      default: "Tape",
    },
    tapeId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "onModel",
      required: true,
      index: true,
    },

    sourceLocation: {
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

    dispatchedQuantity: {
      type: Number,
      default: 0,
    },

    poDate: {
      type: Date,
    },

    poNumber: {
      type: String,
      trim: true,
    },

    // Rate used to create/update the sales order (can differ from current binding rate)
    orderRate: {
      type: Number,
      default: 0,
    },

    estimatedDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "DISPATCHED", "DELIVERED", "CANCELLED"],
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

    submissionToken: {
      type: String,
      trim: true,
      immutable: true,
    },

    orderSignature: {
      type: String,
      trim: true,
      immutable: true,
    },
  },
  {
    timestamps: true,
  },
);

// Speeds up availability lookups and pending-booked aggregation
tapeSalesOrderSchema.index({ tapeId: 1, status: 1, sourceLocation: 1 });
// Speeds up pending list & user-based lookups
tapeSalesOrderSchema.index({ status: 1, createdAt: -1 });
tapeSalesOrderSchema.index({ userId: 1, status: 1 });
tapeSalesOrderSchema.index({ submissionToken: 1 }, { unique: true, sparse: true });
tapeSalesOrderSchema.index({ orderSignature: 1 }, { unique: true, sparse: true });

export default mongoose.models.TapeSalesOrder || mongoose.model("TapeSalesOrder", tapeSalesOrderSchema);
