import mongoose from "mongoose";

const payrollSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true
    },

    month: {
      type: Number,
      min: 1,
      max: 12,
      required: true
    },

    year: {
      type: Number,
      required: true
    },

    presentDays: {
      type: Number,
      required: true
    },

    absentDays: {
      type: Number,
      required: true
    },

    otHours: {
      type: Number,
      default: 0
    },

    incentive: {
      type: Number,
      default: 0
    },

    advance: {
      type: Number,
      default: 0
    },

    totalAdditions: {
      type: Number,
      default: 0,
    },

    grossSalary: Number,
    totalDeduction: Number,
    takeAway: Number,
    reason: String
  },
  { timestamps: true }
);

export default mongoose.model("Payroll", payrollSchema);
