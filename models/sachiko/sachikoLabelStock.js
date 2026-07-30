import mongoose from "mongoose";

const sachikoLabelStockSchema = new mongoose.Schema(
  {
    labelStockId: { type: String, required: true, unique: true },
    skuCode: { type: String, required: true, unique: true },
    productCode: { type: String, required: true, trim: true },
    rollType: { type: String, trim: true, enum: ["NORMAL", "DOUBLE RELEASE", "DOUBLE FACESTOCK"], default: "NORMAL" },
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
    // Second layer, only populated when rollType calls for it:
    // DOUBLE FACESTOCK -> facestock2 + adhesive2 (two facestock/adhesive pairs, one release liner)
    // DOUBLE RELEASE   -> adhesive2 + releaseLiner2 (one facestock, two adhesive/release-liner pairs)
    facestock2: {
      facestockFamily: { type: String, trim: true },
      facestockType: { type: String, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive2: {
      adhesiveType: { type: String, trim: true },
      adhesiveGsm: { type: Number },
    },
    releaseLiner2: {
      releaseLinerType: { type: String, trim: true },
      releaseLinerColor: { type: String, trim: true, default: "WHITE" },
      releaseLinerGsm: { type: Number },
    },
  },
  { timestamps: true },
);

const SachikoLabelStock = mongoose.model(
  "SachikoLabelStock",
  sachikoLabelStockSchema,
  "labelstocks",
);

export default SachikoLabelStock;
