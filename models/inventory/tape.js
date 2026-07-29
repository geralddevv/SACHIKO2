import mongoose from "mongoose";

const tapeSchema = new mongoose.Schema(
  {
    /* ================= IDENTIFICATION ================= */
    tapeProductId: {
      type: String, // FS | Tape | 000001
      required: true,
      unique: true,
      trim: true,
    },

    /* ================= MATERIAL SPECS ================= */
    tapePaperCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    tapeGsm: {
      type: Number,
      required: true,
      index: true,
    },

    tapePaperType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    tapeWidth: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true,
    },

    tapeMtrs: {
      type: Number,
      required: true,
      index: true,
    },

    tapeCoreId: {
      type: Number,
      enum: [0.5, 1, 2, 3],
      required: true,
      index: true,
    },

    tapeFinish: {
      type: String,
      enum: ["MATTE", "GLOSSY", "CLEAR"],
      required: true,
      index: true,
    },

    tapeAdhesiveGsm: {
      type: String,
      required: true,
    },

    tapeSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    tapeMinQty: {
      type: Number,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },

    /* ================= AUDIT ================= */
    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.models.Tape || mongoose.model("Tape", tapeSchema);
