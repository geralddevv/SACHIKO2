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
    // One entry per raw-material layer this item's recipe calls for
    // (LAYER_ORDER in utils/labelStockProduction.js), recording whichever
    // reel/drum(s) were picked in the "Raw Material Allotment" section of the
    // assign form -- independent of whether every layer got picked. Lets the
    // machine queue show allocation per material (Facestock/Adhesive/Release
    // Liner, ...) instead of one all-or-nothing Deckle count, since they're
    // not even the same kind of unit (rolls vs. Adhesive's drums). Keyed by
    // layer key ("facestock", "adhesive", "releaseLiner", "facestock2", ...);
    // each value is { pool, stockIds } naming which pool model (FacestockStock/
    // AdhesiveStock/ReleaseLinerStock) and the doc(s) to look up -- a layer
    // can hold more than one reel picked at once (Assign Production's pickers
    // are checkboxes, not single-select, so e.g. two undersized drums can be
    // combined onto one order). The queue always re-reads rollId/reelMtrs
    // live off those docs rather than snapshotting them here, same as
    // allottedRollIds/MaterialStock above. Orders assigned before this
    // changed still have the old singular { pool, stockId } shape saved --
    // read through utils/labelStockProduction.js's pickStockIds() rather
    // than `.stockId` directly, so both shapes keep working without a data
    // migration.
    allottedLayers: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    // Best-effort "someone has already started drawing on this reel for
    // this order" hint -- set the instant an operator scans a roll and
    // presses Start on a Job Setting/Production Log row (POST /sachiko/
    // machine/jobcard/mark-in-use), long before the real consumption
    // (facestockUsage/adhesiveUsage/releaseUsage on MachineJobCard) exists,
    // which only gets written once the whole card is saved. Pool-keyed
    // (facestock/adhesive/release -- not per recipe layer: Start doesn't
    // know which layer a scanned reel belongs to any more than the Material
    // Used dialog does), each an array of that pool's Stock _ids. Cleared
    // the moment the real job card save happens, superseded by the
    // permanent record -- see POST /sachiko/machine/jobcard/form. Never
    // itself read for deduction -- purely a live visibility hint for
    // /sachiko/facestockstock (and Adhesive/Release Liner Stock).
    liveMaterialInUse: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
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
