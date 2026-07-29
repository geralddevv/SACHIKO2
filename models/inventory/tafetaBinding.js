import mongoose from "mongoose";

const tafetaBindingSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    tafetaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tafeta",
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
    tafetaClientMaterialCode: {
      type: String,
      required: true,
      trim: true,
    },
    tafetaClientMaterialType: {
      type: String,
      required: true,
      trim: true,
    },
    clientTafetaGsm: {
      type: String,
      required: true,
      trim: true,
    },
    tafetaMtrsDel: {
      type: String,
      required: true,
      trim: true,
    },

    // Location this binding belongs to (one of the user's locationDetails).
    location: {
      type: String,
      required: true,
      trim: true,
    },

    /* ================= PRICING & COST ================= */
    tafetaRatePerRoll: {
      type: Number,
      required: true,
      min: 0,
    },
    tafetaSaleCost: {
      type: Number,
      required: true,
      min: 0,
    },

    /* ================= ORDER TERMS ================= */
    tafetaMinQty: {
      type: Number,
      required: true,
      min: 1,
    },
    tafetaOdrQty: {
      type: Number,
      required: true,
      min: 1,
    },
    tafetaOdrFreq: {
      type: String,
      required: true,
      trim: true,
    },
    tafetaCreditTerm: {
      type: String,
      required: true,
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

/* Ensure a user can only be bound to a specific Tafeta master once per location */
tafetaBindingSchema.index({ userId: 1, tafetaId: 1, location: 1 }, { unique: true });

const TafetaBinding = mongoose.model("TafetaBinding", tafetaBindingSchema);
export default TafetaBinding;
