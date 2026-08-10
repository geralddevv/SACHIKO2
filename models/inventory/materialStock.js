import mongoose from "mongoose";

// One doc = one physical reel of finished, laminated Label Stock (a
// "Deckle") matching one specific SachikoLabelStock SKU/recipe. Mirrors
// FAIRTECH's PaperStock, but scoped to that SKU instead of a separate Paper
// master -- Sachiko has no such master, the label stock's own facestock/
// adhesive/releaseLiner fields (via `material`) are the spec identity.
// Created by Label Stock Production (routes/sachiko/labelStockProduction.js),
// which allocates and deducts one raw-material reel per recipe layer from
// FacestockStock/AdhesiveStock/ReleaseLinerStock to laminate it.
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
    rate: {
      type: Number,
    },
    // System-generated CODE/YY-YY/NNN, printed on the reel's QR label.
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
  },
  { timestamps: true },
);

materialStockSchema.index({ material: 1, location: 1 });

export default mongoose.models.MaterialStock || mongoose.model("MaterialStock", materialStockSchema);
