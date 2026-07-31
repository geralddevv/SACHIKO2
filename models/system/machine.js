import mongoose from "mongoose";

const machineSchema = new mongoose.Schema(
  {
    machineName: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    machineWidth: {
      type: Number,
      required: true,
    },
    // Optional so existing machines (created before this field existed) keep
    // working; the machine queue overview groups by location when present.
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      index: true,
    },
    // Free text, not an enum -- this codebase's machine categories (e.g.
    // "Coating", "Slitting") aren't fixed the way a printing-press vocabulary
    // would be.
    machineType: {
      type: String,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

// Same machine name allowed at different locations, not at the same one.
machineSchema.index({ machineName: 1, location: 1 }, { unique: true });

const Machine = mongoose.models.Machine || mongoose.model("Machine", machineSchema);
export default Machine;
