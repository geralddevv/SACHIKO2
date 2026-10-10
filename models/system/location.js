import mongoose from "mongoose";
import { verificationFields } from "../../utils/verification.js";

const locationSchema = new mongoose.Schema(
  {
    locationName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    ...verificationFields,
  },
  { timestamps: true },
);

const Location = mongoose.model("Location", locationSchema);
export default Location;
