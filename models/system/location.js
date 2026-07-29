import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    locationName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const Location = mongoose.model("Location", locationSchema);
export default Location;
