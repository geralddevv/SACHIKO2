import mongoose from "mongoose";

const loanLogSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Loan",
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
      enum: ["CREDIT", "DEBIT"], // CREDIT = loan taken, DEBIT = EMI paid
      required: true,
    },

    source: {
      type: String,
      enum: ["PAYROLL", "MANUAL"],
      required: true,
    },

    month: Number,
    year: Number,
  },
  { timestamps: true }
);

export default mongoose.model("LoanLog", loanLogSchema);
