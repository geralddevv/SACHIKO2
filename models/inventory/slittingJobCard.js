import mongoose from "mongoose";

// The SLITTING step, as one document with a two-stage life:
//
//   1. ALLOCATED -- a planner opens /sachiko/slitting/allocate/:pendingId and
//      fixes the whole job up front: which slitting machine, which operator
//      and helper, which Deckles to cut, and for each Deckle its web width,
//      the metres to take off it, the length to wind on each finished roll,
//      and the A..G knife layout across the web. Nothing has moved in stock
//      at this point -- it is a plan.
//
//   2. COMPLETED -- the operator opens the card off their machine queue and
//      works it one Deckle at a time: scan the reel, Start, Stop, confirm the
//      metres that actually ran. Each Stop inwards that row's finished rolls
//      (FinishedStock) and draws the metres off the Deckle (MaterialStock).
//      The card completes when its last row is done.
//
// This is the step AFTER the laminator's own job card
// (models/inventory/machineJobCard.js): that one turns raw reels into Deckles
// ("Semi Finished Goods"); this one cuts those webs into the finished roll
// widths a client order asked for ("Finished Goods"). The split between plan
// and run mirrors Assign Production -> Machine Job Card exactly.

// The order's requirement, as written across the top of the paper card -- the
// finished width(s) this job is cutting to. Set by the planner; descriptive
// only, since what is actually produced is each row's knife layout.
const requirementRowSchema = new mongoose.Schema(
  {
    width: { type: Number },        // finished roll width, mm
    runningMeter: { type: Number }, // length of one finished roll, metres
    qty: { type: Number },          // how many rolls of that size
  },
  { _id: false },
);

// One knife position across the web: the width it cuts, and -- once the row
// has been run -- the finished roll it produced, so a roll traces back to the
// exact slot it came off.
const rollWidthSchema = new mongoose.Schema(
  {
    slot: { type: String, trim: true, uppercase: true }, // A..G
    width: { type: Number },
    rollId: { type: String, trim: true, uppercase: true },
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedStock" },
  },
  { _id: false },
);

// One Deckle put through the slitter. The planned* fields are the planner's;
// everything below them is the operator's, written when Stop is confirmed.
const slittingRowSchema = new mongoose.Schema(
  {
    // Live traceability link to the Deckle reel, plus its printed id
    // snapshotted so the filed card stays readable after the reel is emptied.
    deckleStockId: { type: mongoose.Schema.Types.ObjectId, ref: "MaterialStock" },
    deckleId: { type: String, trim: true, uppercase: true },
    // Web width of the Deckle, in mm -- what the roll widths have to fit in.
    width: { type: Number },
    cuts: [rollWidthSchema],

    // ---- planned (allocation) ----
    plannedMeter: { type: Number },
    plannedRunningMeter: { type: Number },
    // Server-minted at allocation time, so the produce call for this row is
    // idempotent: if a Stop commits but its response is lost, the retry
    // matches on the token and returns the same rolls instead of inwarding a
    // second set. Never client-supplied.
    rowToken: { type: String, trim: true, index: { unique: true, sparse: true } },

    // ---- actual (the run) ----
    status: { type: String, enum: ["pending", "done"], default: "pending" },
    // Metres that actually came OFF the Deckle (deducted from
    // MaterialStock.reelMtrs), and the length wound on each finished roll.
    // Normally equal, and deliberately kept apart: the paper card records
    // both, and a rewound or joined run makes them differ.
    meter: { type: Number },
    runningMeter: { type: Number },
    // Edge trim left over: width - sum(cuts). Stored rather than derived so
    // the filed card reports the waste actually booked at run time.
    trim: { type: Number },
    joint: { type: String, trim: true },
    jointMtr: { type: Number },
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
    producedAt: { type: Date },
  },
  { _id: false },
);

const slittingJobCardSchema = new mongoose.Schema(
  {
    slittingJobCardId: {
      type: String,
      required: true,
      unique: true,
    },
    // Idempotency key for the allocation POST -- a resubmit of the same
    // loaded page reuses this token and is rejected by the unique index.
    submissionToken: {
      type: String,
      index: { unique: true, sparse: true },
    },
    // "allocated" while the operator still has rows to run; "completed" once
    // every row has been produced. Only one allocated card may be open per
    // order at a time -- see routes/system/slitting.js.
    status: {
      type: String,
      enum: ["allocated", "completed"],
      default: "allocated",
      index: true,
    },
    date: { type: Date, required: true },

    // The only live order link; everything else below is a snapshot taken at
    // allocation time, matching MachineJobCard's own convention so the filed
    // card stays stable if the order is edited later.
    pendingProductionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingProduction",
      index: true,
    },
    // Which slitting machine the job sits on -- this is what puts it on that
    // machine's queue, and so in front of the operator who signs in there.
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine", index: true },
    machineName: { type: String, trim: true },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    operatorName: { type: String, trim: true },
    helperId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    helperName: { type: String, trim: true },

    clientOrderNo: { type: String, trim: true },
    clientName: { type: String, trim: true },
    productCode: { type: String, trim: true },
    lotNo: { type: String, trim: true },
    // Where the finished rolls are inwarded (the Deckles' own location).
    location: { type: String, trim: true },

    requirements: [requirementRowSchema],
    slittingLog: [slittingRowSchema],

    // Roll-up over the rows actually produced, so the records list doesn't
    // have to re-add them. Recomputed on every Stop.
    totalDeckleMeter: { type: Number, default: 0 },
    totalRolls: { type: Number, default: 0 },
    totalFinishedMeter: { type: Number, default: 0 },

    allocatedBy: { type: String, trim: true },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

// The operator's machine queue reads exactly this pair.
slittingJobCardSchema.index({ machineId: 1, status: 1 });

export default mongoose.models.SlittingJobCard
  || mongoose.model("SlittingJobCard", slittingJobCardSchema, "slittingjobcards");
