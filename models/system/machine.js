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
    // Run speed in metres per minute. The WIP pages' Live / Target / Status /
    // Estimate columns time a job off its machine's speed; a machine with none
    // set falls back to the default (laminator 15, slitter 30 --
    // utils/productionEta.js).
    speedMpm: {
      type: Number,
      min: 0,
    },
  },
  { timestamps: true },
);

// Same machine name allowed at different locations, not at the same one.
machineSchema.index({ machineName: 1, location: 1 }, { unique: true });

const Machine = mongoose.models.Machine || mongoose.model("Machine", machineSchema);
export default Machine;
