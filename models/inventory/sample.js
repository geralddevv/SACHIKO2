import mongoose from "mongoose";

const sampleSchema = new mongoose.Schema(
  {
    /* ================= IDENTIFICATION ================= */
    sampleCode: {
      type: String, // FS | TTR | VSMP | 000001
      required: true,
      unique: true,
      trim: true,
    },

    sampleCategory: {
      type: String,
      required: true,
      enum: ["vendor", "client"],
      index: true,
    },

    sampleMaterial: {
      type: String,
      trim: true,
      index: true,
    },

    /* ================= SAMPLE DETAILS ================= */
    sampleDate: { type: String },
    sampleType: { type: String, trim: true },
    sampleBlock: { type: String, trim: true },
    sampleWidth: { type: String, trim: true },
    sampleHeight: { type: String, trim: true },
    jobNo: { type: String, trim: true },
    purchaseRate: { type: mongoose.Schema.Types.Mixed },
    deckleMm: { type: mongoose.Schema.Types.Mixed },
    moqSqMtrs: { type: mongoose.Schema.Types.Mixed },

    /* ================= VENDOR FIELDS ================= */
    vendorName: { type: String, trim: true },
    vendorCode: { type: String, trim: true },

    /* ================= CLIENT FIELDS ================= */
    fairtechName: { type: String, trim: true },
    fairtechCode: { type: String, trim: true },
    clientName: { type: String, trim: true },

    /* ================= COMMON ================= */
    salesPerson: { type: String, trim: true },
    application: { type: String, trim: true },
    remark: { type: String, trim: true },

    /* ================= AUDIT ================= */
    createdBy: { type: String, default: "SYSTEM" },
  },
  { timestamps: true },
);

export default mongoose.models.Sample || mongoose.model("Sample", sampleSchema);
