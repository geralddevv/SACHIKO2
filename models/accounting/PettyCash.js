import mongoose from "mongoose";

const pettyCashSchema = new mongoose.Schema(
  {
    currentBalance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "CLOSED"],
      default: "ACTIVE",
    },
    location: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("PettyCash", pettyCashSchema);
