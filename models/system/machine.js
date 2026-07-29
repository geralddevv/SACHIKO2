import mongoose from "mongoose";

const machineSchema = new mongoose.Schema(
  {
    machineName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const Machine = mongoose.model("Machine", machineSchema);
export default Machine;
