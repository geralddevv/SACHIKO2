import mongoose from "mongoose";

const payrollLogSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    payroll: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payroll",
      required: true,
    },

    month: Number,
    year: Number,

    baseSalary: Number,
    presentDays: Number,
    absentDays: Number,
    otHours: Number,

    totalAdditions: Number,
    incentive: Number,
    advance: Number,

    grossSalary: Number,
    totalDeduction: Number,
    takeAway: Number,

    source: {
      type: String,
      enum: ["MANUAL", "SYSTEM"],
      default: "SYSTEM",
    },
  },
  { timestamps: true }
);

export default mongoose.model("PayrollLog", payrollLogSchema);
