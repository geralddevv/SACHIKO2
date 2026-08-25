import mongoose from "mongoose";

// Type master -- the list backing the "Type" dropdown on Facestock Master,
// Adhesive Master, and Release Master (views/inventory/masters/
// facestockMaster.ejs, adhesiveMaster.ejs, releaseMaster.ejs), which used to
// be three separate hardcoded <option> lists duplicated across those files.
// See scripts/backfill-type-master-seed.js for the one-off seed of whatever
// type names were already in use before this master existed. Mirrors
// models/system/family.js.
const typeSchema = new mongoose.Schema(
  {
    typeName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const Type = mongoose.model("Type", typeSchema);
export default Type;
