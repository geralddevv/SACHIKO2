import mongoose from "mongoose";
const Schema = mongoose.Schema;

const tafetaSchema = new Schema(
  {
    /* ================= IDENTIFICATION ================= */
    tafetaProductId: {
      type: String, // FS | Tafeta | 000001
      required: true,
      unique: true,
      trim: true,
    },
    /* ================= MATERIAL SPECS ================= */
    tafetaMaterialCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tafetaMaterialType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tafetaColor: {
      type: String,
      required: true,
      trim: true,
    },
    tafetaGsm: {
      type: String,
      required: true,
      trim: true,
    },
    /* ================= DIMENSIONS & PACKAGING ================= */
    tafetaWidth: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      trim: true,
      index: true, // often filtered
    },
    tafetaMtrs: {
      type: String,
      required: true,
      trim: true,
    },
    tafetaCoreLen: {
      type: String,
      required: true,
    },
    tafetaNotch: {
      type: String,
      required: true,
    },
    tafetaCoreId: {
      type: String,
      required: true,
      trim: true,
    },

    tafetaSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    tafetaMinQty: {
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

/* Create Compound Indexes for fast specification filtering */
tafetaSchema.index({ tafetaMaterialCode: 1, tafetaMaterialType: 1, tafetaWidth: 1 });

const Tafeta = mongoose.model("Tafeta", tafetaSchema);
export default Tafeta;
