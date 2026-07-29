import mongoose from "mongoose";

const pettyCashLogSchema = new mongoose.Schema(
  {
    location: {
      type: String,
      required: true,
    },

    from: {
      type: String,
      trim: true,
      default: "",
    },

    to: {
      type: String,
      trim: true,
      default: "",
    },

    openingBalance: {
      type: Number,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    closingBalance: {
      type: Number,
      required: true,
    },

    entryDate: {
      type: String,
      required: true,
      default: () => new Date().toISOString().split("T")[0],
    },

    type: {
      type: String,
      enum: ["INWARD", "OUTWARD"],
      required: true,
    },

    reason: {
      type: String,
      trim: true,
    },

    source: {
      type: String,
      enum: ["MANUAL", "SYSTEM"],
      default: "MANUAL",
    },
  },
  { timestamps: true }
);

export default mongoose.model("PettyCashLog", pettyCashLogSchema);
