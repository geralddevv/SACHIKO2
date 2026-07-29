import mongoose from "mongoose";

const advanceLogSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    advance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Advance",
      required: true,
    },

    openingBalance: {
      type: Number,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
    },

    closingBalance: {
      type: Number,
      required: true,
    },

    type: {
      type: String,
      enum: ["CREDIT", "DEBIT"],
      required: true,
    },

    source: {
      type: String,
      enum: ["MANUAL", "PAYROLL"],
      required: true,
    },

    month: Number,
    year: Number,
  },
  { timestamps: true }
);

export default mongoose.model("AdvanceLog", advanceLogSchema);
