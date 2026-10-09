import mongoose from "mongoose";

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 },
    // Set when a Deckle No series was moved BELOW existing Deckles by a forced
    // override (Lot No & Deckle No Setup): only Deckles made from then on count
    // toward the series floor.
    forcedAt: { type: Date },
  },
  { timestamps: true },
);

const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);

export default Counter;
