import mongoose from "mongoose";

const loanSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      unique: true,
    },

    currentBalance: {
      type: Number,
      required: true,
      min: 0,
    },

    emi: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "CLOSED"],
      default: "ACTIVE",
    },
  },
  { timestamps: true }
);


export default mongoose.models.Loan || mongoose.model("Loan", loanSchema);
