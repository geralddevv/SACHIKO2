import mongoose from "mongoose";

const posRollSchema = new mongoose.Schema(
  {
    /* ================= IDENTIFICATION ================= */
    posProductId: {
      type: String, // FS | POS Roll | 000001
      required: true,
      unique: true,
      trim: true,
    },

    /* ================= MATERIAL SPECS ================= */
    posPaperCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    posPaperType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    posColor: {
      type: String,
      enum: ["WHITE", "BLUE", "YELLOW", "PINK"],
      required: true,
      index: true,
    },

    posGsm: {
      type: Number,
      required: true,
      index: true,
    },

    posWidth: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true,
    },

    posMtrs: {
      type: Number,
      required: true,
      index: true,
    },

    posCoreId: {
      type: Number,
      enum: [0.5, 1, 2, 3],
      required: true,
      index: true,
    },

    posSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    posMinQty: {
      type: Number,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.models.PosRoll || mongoose.model("PosRoll", posRollSchema);
