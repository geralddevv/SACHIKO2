import mongoose from "mongoose";

// The SLITTING step, as one document with a two-stage life:
//
//   1. ALLOCATED -- a planner opens
//      /sachiko/slitting/allocate/:pendingId?deckle=<stockId> from the
//      Slitting Queue and fixes ONE Deckle's job up front: which slitting
//      machine, which operator and helper, and for that Deckle its web width,
//      the metres to take off it, the length to wind on each finished roll,
//      and the A..L knife layout across the web. Nothing has moved in stock
//      at this point -- it is a plan. The order's other Deckles are each
//      allocated on their own card.
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
    slot: { type: String, trim: true, uppercase: true }, // A..L
    width: { type: Number },
    // The sales-order width this knife is filling, when it differs from what
    // is cut -- the Set Deckle page's "grace" shares spare web out over the
    // rolls, so the reel comes off wider than it was ordered. Resolved from
    // the batch's own deckleLayout when the allocation is saved, and it is
    // this width the finished roll is booked and billed at. Absent on an
    // ungraced cut, where the two are the same number.
    orderedWidth: { type: Number },
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
    // Every Deckle this row was re-pointed AWAY from by a scan (oldest first),
    // so the Deckle the planner allocated is not lost when the operator runs a
    // different web of the same spec. Lets the queue show it as unused stock
    // that came off this card.
    swappedFrom: [
      {
        _id: false,
        deckleStockId: { type: mongoose.Schema.Types.ObjectId, ref: "MaterialStock" },
        deckleId: { type: String, trim: true, uppercase: true },
        cardId: { type: mongoose.Schema.Types.ObjectId, ref: "SlittingJobCard" },
        slittingJobCardId: { type: String, trim: true },
        at: { type: Date, default: Date.now },
        by: { type: String, trim: true },
      },
    ],
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
    // The slitting machine's own counter readings at the moment Start and
    // Stop were punched -- same role as MachineJobCard's productionLogRowSchema
    // startMtrs/stopMtrs (and this card's own Job Setting mtrs1/mtrs2): the
    // form won't let either be punched without its reading. `meter` below is
    // NOT derived from these two -- the UI defaults it to their difference,
    // but it stays the operator's own confirmed figure, editable before Stop.
    startMtrs: { type: Number },
    stopMtrs: { type: Number },
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
    // Server-clock timestamps for the Slitting WIP page's live Deckle/ETA
    // (utils/productionEta.js buildSlittingRunPlan). startedAt is stamped the
    // moment Start is punched (routes/system/slitting.js startSlittingRow);
    // producedAt the moment Stop inwards the rolls. The punched startTime/
    // endTime strings above stay as the operator's own record -- these two are
    // the clock the WIP page counts from, exactly as lamination's liveRun /
    // Deckle createdAt do (routes/fairdesk_route.js buildJobCardProgressMap).
    startedAt: { type: Date },
    producedAt: { type: Date },
  },
  { _id: false },
);

// Job Setting: setup wastage before the first Deckle is cut, measured off the
// machine's own counter -- a start and a stop reading rather than a length.
// Same shape/purpose as MachineJobCard's own jobSetting (models/inventory/
// machineJobCard.js), just without roll ids -- slitting's material is the
// allocated Deckle itself, scanned in its own step further down the card.
const jobSettingRowSchema = new mongoose.Schema(
  {
    mtrs1: { type: Number },
    startTime: { type: String, trim: true },
    mtrs2: { type: Number },
    stopTime: { type: String, trim: true },
    // Server-clock stamps for the WIP page's JOB SETTING phase, written by the
    // per-punch setting/start and setting/stop endpoints. The mtrs/time strings
    // above remain the operator's record; these drive the live clock.
    startedAt: { type: Date },
    stoppedAt: { type: Date },
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
    // every row has been produced. One card per Deckle: an order's Deckles
    // are each allocated separately and get their own card -- see
    // routes/system/slitting.js.
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
    jobSetting: [jobSettingRowSchema],
    slittingLog: [slittingRowSchema],

    // Roll-up over the rows actually produced, so the records list doesn't
    // have to re-add them. Recomputed on every Stop.
    totalDeckleMeter: { type: Number, default: 0 },
    totalRolls: { type: Number, default: 0 },
    totalFinishedMeter: { type: Number, default: 0 },

    // ---- live signals for the Slitting WIP page -----------------------------
    // The exact counterparts of PendingProduction's own live fields (see
    // models/inventory/pendingProduction.js) -- the Slitting WIP page
    // (routes/system/slitting.js buildSlittingProgressMap -> buildSlittingRunPlan)
    // reads them the same way the lamination WIP reads those. The running Deckle
    // itself needs no `liveRun`: unlike MachineJobCard (written once at save),
    // this card is updated per punch, so the started-not-done slittingLog row
    // (its own startedAt) IS the deckle on the machine now.
    //
    // Which device is running this card now, claimed at the first punch and
    // heartbeated while the job card is open. Its presence is "started"; its
    // freshness (activeClaim, routes/api/operatorApi.js) is "running now".
    runningOn: {
      deviceId: { type: String },
      deviceLabel: { type: String },
      claimedAt: { type: Date },
      lastSeenAt: { type: Date },
    },
    // The Job Setting row running RIGHT NOW (index into jobSetting), set by its
    // Start punch and cleared by its Stop, by a Deckle Start, by card completion.
    liveSetting: {
      index: { type: Number },
      startedAt: { type: Date },
      startTime: { type: String, trim: true },
      startMtrs: { type: Number },
    },
    // When this card was first played -- the first punch of any kind. Set once ($min).
    liveStartedAt: { type: Date },
    // The card is ON HOLD (operator tapped Pause). Cleared by Resume or by any
    // later punch (endLivePause). The WIP page holds the job's clock at `since`.
    livePause: {
      since: { type: Date },
      reason: { type: String, trim: true },
      deviceLabel: { type: String, trim: true },
    },
    // Every hold this card has come back out of, oldest first, capped at
    // LIVE_PAUSE_LOG_MAX. The WIP page takes these out of every clock.
    livePauseLog: {
      type: [
        {
          from: { type: Date },
          to: { type: Date },
          reason: { type: String, trim: true },
          _id: false,
        },
      ],
      default: undefined,
    },

    // The "why was it late?" reminder (operator app): one entry per overdue
    // Deckle run, remark optional. Shown on the Slitting WIP page.
    overtimeLog: {
      type: [
        {
          // Which Deckle ran over, and which run of it (its Start time), so a
          // re-run of the same Deckle number is told apart from the first.
          deckleIndex: { type: Number },
          runStartedAt: { type: Date },
          // The Start punch's row token (lamination) -- how a remark that arrives
          // late, from the app's outbox, is matched to its run and never stored twice.
          rowToken: { type: String, trim: true },
          // Why it ran late, as the operator typed it. Empty = the operator
          // dismissed the reminder without a remark -- stored anyway so the
          // reminder is only ever shown ONCE for that run.
          remark: { type: String, trim: true, maxlength: 500, default: "" },
          at: { type: Date, default: Date.now },
          byName: { type: String, trim: true },
          _id: false,
        },
      ],
      default: undefined,
    },

    allocatedBy: { type: String, trim: true },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

// The operator's machine queue reads exactly this pair.
slittingJobCardSchema.index({ machineId: 1, status: 1 });

export default mongoose.models.SlittingJobCard
  || mongoose.model("SlittingJobCard", slittingJobCardSchema, "slittingjobcards");
