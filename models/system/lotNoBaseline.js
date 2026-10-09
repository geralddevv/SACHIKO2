import mongoose from "mongoose";

// TEMPORARY -- "the last Lot No already used" for a product code in a
// financial year, for lots made before this system tracked them (so they are
// in no PendingProduction / MachineJobCard to be counted). The next auto Lot
// No is max(this, highest serial in the database) + 1. Set from
// /labels/production/lot-no-setup. Safe to leave in place after setup: once
// real lots overtake it, it simply stops mattering.
const lotNoBaselineSchema = new mongoose.Schema(
  {
    productCode: { type: String, required: true, trim: true, uppercase: true },
    fy: { type: String, required: true, trim: true },
    lastSerial: { type: Number, required: true, min: 0 },
    updatedBy: { type: String, trim: true },
    // Set when the series was forced BELOW lots already on file: only lots
    // created from then on count toward "the highest used".
    forcedAt: { type: Date },
  },
  { timestamps: true },
);

lotNoBaselineSchema.index({ productCode: 1, fy: 1 }, { unique: true });

const LotNoBaseline =
  mongoose.models.LotNoBaseline || mongoose.model("LotNoBaseline", lotNoBaselineSchema, "lotnobaselines");

export default LotNoBaseline;
