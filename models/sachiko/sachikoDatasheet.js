import mongoose from "mongoose";

const sachikoDatasheetSchema = new mongoose.Schema(
  {
    datasheetId: { type: String, required: true, unique: true },
    productCode: { type: String, required: true, trim: true },
    wordFile: { type: String },
    wordFileOriginalName: { type: String },
    facestock: {
      facestockFamily: { type: String, trim: true },
      facestockType: { type: String, required: true, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive: {
      adhesiveType: { type: String, required: true, trim: true },
      adhesiveGsm: { type: Number },
    },
    releaseLiner: {
      releaseLinerType: { type: String, required: true, trim: true },
      releaseLinerColor: { type: String, trim: true, default: "WHITE" },
      releaseLinerGsm: { type: Number },
    },
  },
  { timestamps: true },
);

const SachikoDatasheet = mongoose.model(
  "SachikoDatasheet",
  sachikoDatasheetSchema,
  "datasheets",
);

export default SachikoDatasheet;
