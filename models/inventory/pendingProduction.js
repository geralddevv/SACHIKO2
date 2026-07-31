import mongoose from "mongoose";

// The live-synced production queue for Label Stock orders. One doc per
// PENDING TapeSalesOrder where onModel === "SachikoLabelStock" -- kept in
// sync by utils/pendingProduction.js, not written directly by any view.
//
// Deliberately reuses the source order's own _id (see upsertPendingProduction)
// so a PendingProduction id can be passed straight into
// /sachiko/sales/order/status without a second lookup, mirroring FAIRTECH's
// PendingProduction.
const pendingProductionSchema = new mongoose.Schema(
  {
    onModel: {
      type: String,
      default: "SachikoLabelStock",
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SachikoLabelStock",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Username",
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    dispatchedQuantity: {
      type: Number,
      default: 0,
    },
    poNumber: { type: String },
    orderRate: { type: Number },
    estimatedDate: { type: Date },
    remarks: { type: String },

    // Copied from the order at sync time -- replace FAIRTECH's die-derived
    // roll math, since Label Stock orders already collect these directly.
    paperSize: { type: String },
    runningMeters: { type: Number },
    noOfRolls: { type: Number },

    // Set by GET/POST /sachiko/labels/production/assign/:id. Order-sync
    // upserts never touch these fields (see upsertPendingProduction).
    assignedMachineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    helperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    // Snapshot of "No. of Rolls" ticked on the assign form -- kept separate
    // from noOfRolls (the order's own target) so under/over-allotment can be
    // flagged.
    allottedRolls: { type: Number },
    allottedRollIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MaterialStock",
      },
    ],
    lotNo: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    assignedAt: { type: Date },
    // Stamped when a Job Card is saved against this order. Drives the
    // "already produced, can't unassign" guard; order-sync upsert never
    // touches it, so an order edit can't un-finish it.
    producedAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.models.PendingProduction || mongoose.model("PendingProduction", pendingProductionSchema, "pendingproductions");
