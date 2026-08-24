import mongoose from "mongoose";

// Family master -- the list backing the "Family" dropdown on Label Stock
// View (views/sachiko/labelStockView.ejs) and Facestock Master
// (views/inventory/masters/facestockMaster.ejs), which used to be a
// hardcoded <option> list duplicated in both files. See
// scripts/backfill-family-master-seed.js for the one-off seed of whatever
// family names were already in use before this master existed.
const familySchema = new mongoose.Schema(
  {
    familyName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const Family = mongoose.model("Family", familySchema);
export default Family;
