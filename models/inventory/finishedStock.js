import mongoose from "mongoose";

// One doc = one physical finished roll, slit off a Deckle (MaterialStock) to
// a client order's spec. Mirrors MaterialStock's shape -- quantity is always
// 1 (or 0 once dispatched/consumed elsewhere), same "one doc = one physical
// unit" convention as every other roll-identified stock in this codebase.
// Created by routes/stock/finishedStock.js's POST /create ("Produce" dialog),
// never by job cards -- a Production Log row is a meter-reading checkpoint
// against the scanned input Deckle, not a reliable 1:1 stand-in for one
// output roll, so finished-roll creation is its own explicit action.
const finishedStockSchema = new mongoose.Schema(
  {
    pendingProductionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingProduction",
      required: true,
      index: true,
    },
    // Denormalized from the order's itemId -- the Label Stock SKU this roll is.
    material: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SachikoLabelStock",
      required: true,
      index: true,
    },
    // Which Deckle this roll was slit from.
    deckleStockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MaterialStock",
      required: true,
    },
    deckleRollId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    location: {
      type: String,
      required: true,
      index: true,
    },
    // The width this roll is SOLD as -- the sales order's own size. Everything
    // commercial reads it: the rate lookup, the client's bill, the export to
    // FAIRTECH.
    paperSize: {
      type: String,
      trim: true,
    },
    // What the knife actually cut, in mm, when the Set Deckle page's "grace"
    // made the reel wider than it was ordered (spare web shared out over the
    // rolls instead of being scrapped as side trim). Physical truth, for the
    // shopfloor and for tracing a reel back to its layout -- never for
    // pricing. Absent on an ungraced roll, where it equals paperSize.
    cutWidth: {
      type: Number,
    },
    lotNo: {
      type: String,
      trim: true,
    },
    clientName: {
      type: String,
      trim: true,
    },
    // Rolls -- 1, or 0 once emptied/dispatched.
    quantity: {
      type: Number,
      required: true,
      default: 1,
    },
    // Set when the roll is exported to FAIRTECH (routes/stock/finishedStock.js
    // POST /export). The row and its whole ledger history are kept -- these
    // are what say it has LEFT, so the Finished Goods page can list only what
    // is actually in stock and the Dispatched page can show the rest with the
    // invoice it went out on. Recorded outright rather than parsed back out
    // of the OUTWARD log line's remarks.
    dispatchedAt: {
      type: Date,
    },
    dispatchInvoiceNo: {
      type: String,
      trim: true,
    },
    // This roll's length.
    mtrs: {
      type: Number,
      required: true,
    },
    rate: {
      type: Number,
    },
    // System-generated ITEMCODE/YY-YY/NNN, same scheme as Deckle ids -- see
    // utils/finishedRollId.js.
    rollId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },
    remarks: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

finishedStockSchema.index({ material: 1, location: 1 });

export default mongoose.models.FinishedStock || mongoose.model("FinishedStock", finishedStockSchema);
