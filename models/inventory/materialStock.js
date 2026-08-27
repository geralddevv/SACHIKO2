import mongoose from "mongoose";

// One doc = one physical reel of finished, laminated Label Stock (a
// "Deckle") matching one specific SachikoLabelStock SKU/recipe. Mirrors
// FAIRTECH's PaperStock, but scoped to that SKU instead of a separate Paper
// master -- Sachiko has no such master, the label stock's own facestock/
// adhesive/releaseLiner fields (via `material`) are the spec identity.
// Created two ways: utils/labelStockProduction.js's produceDeckle() (the
// legacy Assign Production "Produce New Deckle" path, which also allocates
// and deducts the raw-material reels it laminates from), and -- the normal
// path now -- routes/system/machine.js's produceDecklesFromLog, one Deckle
// per Production Log row on the machine job card once a job finishes. Raw
// material for that path was already reserved/deducted earlier (Assign
// Production + the job card's own Adhesive Used dialog), so it only writes
// the finished-goods side.
const materialStockSchema = new mongoose.Schema(
  {
    material: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SachikoLabelStock",
      required: true,
      index: true,
    },
    location: {
      type: String,
      required: true,
      index: true,
    },
    // Rolls -- 1, or 0 once emptied.
    quantity: {
      type: Number,
      required: true,
    },
    // Remaining metres on the reel; decremented by job-card production.
    reelMtrs: {
      type: Number,
      required: true,
    },
    // Finished web size captured from the production order. This stays with
    // the physical Deckle even if the source order is edited later.
    size: {
      type: String,
      trim: true,
    },
    // Joint / wrinkle statuses recorded for this physical Deckle on its
    // machine production-log row. Kept with the reel so its printed label
    // remains accurate after the job card is filed.
    joints: {
      type: String,
      trim: true,
    },
    // Production lot carried onto the physical Deckle and its SOFT.prn label.
    lotNo: {
      type: String,
      trim: true,
    },
    rate: {
      type: Number,
    },
    // System-generated Deckle ID: CODE/YY-YY/<year-letter><lot>/NNNNN,
    // printed on the reel's QR label.
    rollId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },
    vendorRollId: {
      type: String,
      trim: true,
    },
    invoiceNo: {
      type: String,
      trim: true,
    },
    remarks: {
      type: String,
      trim: true,
    },
    // Which raw-material reels this Deckle was laminated from -- one per pool
    // normally, or several facestock entries when a reel ran out mid-run and
    // was swapped. `material` above already records the Product Code / variant
    // this Deckle was produced as; this is the reel-level trace behind it.
    // Written by routes/system/machine.js's produceDecklesFromLog.
    sourceReels: [
      new mongoose.Schema(
        {
          pool: { type: String, trim: true },
          stockId: { type: mongoose.Schema.Types.ObjectId },
          rollId: { type: String, trim: true },
        },
        { _id: false },
      ),
    ],
    // The order whose Assign & Continue laminated this reel. Only set on reels
    // this app produced for an order -- it's what lets sending that order back
    // to Pending un-make exactly the Deckles it made and return their raw
    // material, without touching Deckles that were merely ticked onto the
    // order from existing stock (see dissolveDeckle in
    // utils/labelStockProduction.js). Reels laminated before this field
    // existed carry nothing, and are left alone by that reversal; use
    // scripts/dissolve-deckle.js to return one by hand.
    producedFor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingProduction",
      index: { sparse: true },
    },
  },
  { timestamps: true },
);

materialStockSchema.index({ material: 1, location: 1 });

export default mongoose.models.MaterialStock || mongoose.model("MaterialStock", materialStockSchema);
