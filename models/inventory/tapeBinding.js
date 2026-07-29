import mongoose from "mongoose";

const tapeBindingSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    tapeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tape",
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
    // Client-specific paper code (can differ from master)
    tapeClientPaperCode: {
      type: String,
      required: true,
      trim: true,
    },

    // Client-agreed GSM (can differ from master)
    clientTapeGsm: {
      type: Number,
      required: true,
    },

    // Delivered meters (if partial roll etc.)
    tapeMtrsDel: {
      type: Number,
      default: 0,
    },

    // Client-specific item type or category
    itemClientItemType: {
      type: String,
      trim: true,
    },

    // Location this binding belongs to (one of the user's locationDetails).
    location: {
      type: String,
      required: true,
      trim: true,
    },

    /* ================= PRICING ================= */
    tapeRatePerRoll: {
      type: Number,
      required: true,
    },

    tapeSaleCost: {
      type: Number,
      required: true,
    },

    /* ================= ORDER TERMS ================= */
    tapeMinQty: {
      type: Number,
      required: true,
    },

    tapeOdrQty: {
      type: Number,
      required: true,
    },

    tapeOdrFreq: {
      type: String,
      trim: true,
    },

    tapeCreditTerm: {
      type: String,
      trim: true,
    },

    billingType: {
      type: String,
      enum: ["ROLLS", "RUNNING MTRS"],
      default: "ROLLS",
      required: true,
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

// Duplicate = same user, tape master, client paper code, GSM, item type, and location
tapeBindingSchema.index(
  { userId: 1, tapeId: 1, tapeClientPaperCode: 1, clientTapeGsm: 1, itemClientItemType: 1, location: 1 },
  { unique: true },
);

export default mongoose.models.TapeBinding || mongoose.model("TapeBinding", tapeBindingSchema);
