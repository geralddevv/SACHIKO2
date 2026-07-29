import mongoose from "mongoose";

const posRollBindingSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    posRollId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PosRoll",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Username",
      required: true,
      index: true,
    },

    /* ================= CLIENT OVERRIDES ================= */
    posClientPaperCode: {
      type: String,
      required: true,
      trim: true,
    },

    clientPosGsm: {
      type: Number,
      required: true,
    },

    posMtrsDel: {
      type: Number,
      default: 0,
    },

    // Location this binding belongs to (one of the user's locationDetails).
    location: {
      type: String,
      required: true,
      trim: true,
    },

    /* ================= PRICING ================= */
    posRatePerRoll: {
      type: Number,
      required: true,
    },

    posSaleCost: {
      type: Number,
      required: true,
    },

    /* ================= ORDER TERMS ================= */
    posMinQty: {
      type: Number,
      required: true,
    },

    posOdrQty: {
      type: Number,
      required: true,
    },

    posOdrFreq: {
      type: String,
      trim: true,
    },

    posCreditTerm: {
      type: String,
      trim: true,
    },

    /* ================= STATUS ================= */
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

// Prevent duplicate bindings
posRollBindingSchema.index(
  {
    userId: 1,
    posRollId: 1,
    posClientPaperCode: 1,
    clientPosGsm: 1,
    posRatePerRoll: 1,
    posSaleCost: 1,
    posMinQty: 1,
    posOdrQty: 1,
    posOdrFreq: 1,
    posCreditTerm: 1,
    posMtrsDel: 1,
    location: 1,
  },
  { unique: true },
);

export default mongoose.models.PosRollBinding || mongoose.model("PosRollBinding", posRollBindingSchema);
