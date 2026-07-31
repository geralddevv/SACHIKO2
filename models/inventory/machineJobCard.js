import mongoose from "mongoose";

// Write-once shop-floor document created from the machine queue's "Initiate
// Production" action (routes/system/machine.js POST /machine/jobcard/form).
// No edit route exists by design.
//
// Distinct from models/sachiko/sachikoJobcard.js -- that's Sachiko's
// pre-existing standalone manual-entry job card (no machine/stock linkage),
// left untouched. This one is the machine-queue-driven, roll-scan-and-deduct
// job card ported from FAIRTECH's JobCard.
const materialBlockSchema = new mongoose.Schema(
  {
    rollDrumNo: { type: String, trim: true },
    code: { type: String, trim: true },
    gsmMic: { type: String, trim: true },
    size: { type: String, trim: true },
  },
  { _id: false },
);

const rollRowSchema = new mongoose.Schema(
  {
    rollId: { type: String, trim: true },
    mtrs1: { type: Number },
    startTime: { type: String, trim: true },
    mtrs2: { type: Number },
    stopTime: { type: String, trim: true },
  },
  { _id: false },
);

const machineJobCardSchema = new mongoose.Schema(
  {
    jobCardId: {
      type: String,
      required: true,
      unique: true,
    },
    // Idempotency key -- a resubmit of the same loaded page reuses this
    // token and is rejected by the unique index below.
    submissionToken: {
      type: String,
      index: { unique: true, sparse: true },
    },
    date: {
      type: Date,
      required: true,
    },
    // The only live traceability link; everything else is a plain-text/
    // number snapshot taken at creation time, deliberately not refs, so the
    // printed doc stays stable if the source order/machine is edited later.
    pendingProductionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingProduction",
    },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    machineName: { type: String, trim: true },
    lotNo: { type: String, trim: true },
    productCode: { type: String, trim: true },
    paperSize: { type: String, trim: true },
    rolls: { type: String, trim: true },
    quantity: { type: Number },
    operatorName: { type: String, trim: true },
    helperName: { type: String, trim: true },

    // Descriptive only, not stock-linked -- matches SachikoJobcard's
    // existing shape and FAIRTECH's own JobCard convention (only the roll
    // named by productionLog/jobSetting rollId is actually consumed).
    faceStock: materialBlockSchema,
    adhesive: materialBlockSchema,
    releaseLiner: materialBlockSchema,

    jobSetting: [rollRowSchema],
    productionLog: [rollRowSchema],

    totalMeter: { type: String, trim: true },
    sqMtr: { type: String, trim: true },
  },
  { timestamps: true },
);

export default mongoose.models.MachineJobCard || mongoose.model("MachineJobCard", machineJobCardSchema, "machinejobcards");
