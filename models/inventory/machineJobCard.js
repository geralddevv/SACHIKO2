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

// Job Setting: setup wastage, measured off the machine's own counter -- hence
// a start and a stop reading rather than a length.
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

// Production Log: one row per deckle produced, not per counter run -- the
// deckle's id, the run's clocked start/end, the metres it made, and any
// joint/wrinkle found on the face and release webs. Same shape as Sachiko's
// own job card (models/sachiko/sachikoJobcard.js), which is where this layout
// comes from, plus the rollId SACHIKO2 needs on top: it names which of the
// job's allotted reels the deckle came off, and is what
// consumeAllottedRollMeters deducts `meters` against.
const productionLogRowSchema = new mongoose.Schema(
  {
    rollId: { type: String, trim: true },
    deckleId: { type: String, trim: true },
    meters: { type: Number },
    face: {
      joint: { type: String, trim: true },
      mtr: { type: Number },
    },
    release: {
      joint: { type: String, trim: true },
      mtr: { type: Number },
    },
    time: {
      startTime: { type: String, trim: true },
      endTime: { type: String, trim: true },
    },
  },
  { _id: false },
);

// How much of each reserved Adhesive drum this job actually used, entered by
// the operator in the "Adhesive Used" dialog when Save Production Entry is
// clicked (views/inventory/masters/jobCardForm.ejs) -- raw adhesive is only
// ever *reserved* at Assign Production (routes/sachiko/labelStockProduction.js's
// applyAdhesiveBindings), never automatically deducted the way facestock/
// release liner are (consumeAllottedRollMeters, off the scanned Deckle roll
// IDs) -- there's no length reading to scan for a drum, only a weight the
// operator has to report. `stockId` is the live traceability link
// (AdhesiveStock._id); rollId/kgUsed are a snapshot so the printed card stays
// stable if the drum is edited or emptied later.
const adhesiveUsageRowSchema = new mongoose.Schema(
  {
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "AdhesiveStock" },
    rollId: { type: String, trim: true },
    kgUsed: { type: Number },
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
    productionLog: [productionLogRowSchema],
    adhesiveUsage: [adhesiveUsageRowSchema],

    totalMeter: { type: String, trim: true },
    sqMtr: { type: String, trim: true },
  },
  { timestamps: true },
);

export default mongoose.models.MachineJobCard || mongoose.model("MachineJobCard", machineJobCardSchema, "machinejobcards");
