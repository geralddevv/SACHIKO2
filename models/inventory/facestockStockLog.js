import mongoose from "mongoose";

// Movement ledger mirroring FacestockStock, same split as
// MaterialStock/MaterialStockLog: FacestockStock rows are the actual
// balance, this is the parallel audit trail with its own opening/closing
// snapshot. Written OUTWARD by Label Stock Production
// (routes/sachiko/labelStockProduction.js) when a reel is drawn on to
// laminate a Deckle. No INWARD writer yet -- raw-material inward
// (routes/stock/facestockStock.js) predates this ledger.
//
// Unlike MaterialStockLog, there's no master to populate a spec from (and
// the FacestockStock row consumption only ever zeroes, never deletes, so
// its own family/type/gsm/micron stay readable via rollId) -- so this stays
// as lean as PaperStockLog/TapeStockLog: balance + movement only.
const facestockStockLogSchema = new mongoose.Schema(
  {
    location: {
      type: String,
      required: true,
      index: true,
    },
    openingStock: {
      type: Number,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    closingStock: {
      type: Number,
      required: true,
    },
    reelMtrs: {
      type: Number,
    },
    rate: {
      type: Number,
    },
    rollId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    vendorRollId: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["INWARD", "OUTWARD"],
      required: true,
    },
    source: {
      type: String,
      enum: ["MANUAL", "SYSTEM"],
      default: "MANUAL",
    },
    remarks: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  { timestamps: true },
);

export default mongoose.models.FacestockStockLog || mongoose.model("FacestockStockLog", facestockStockLogSchema);
