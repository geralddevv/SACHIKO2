import mongoose from "mongoose";

const sachikoLabelStockSchema = new mongoose.Schema(
  {
    labelStockId: { type: String, required: true, unique: true },
    skuCode: { type: String, required: true, unique: true },
    productCode: { type: String, required: true, trim: true },
    // Same sha256 signature scheme used for Client/TapeSalesOrder/Facestock
    // Master/... duplicate prevention (see CLAUDE.md "Dialog / modal
    // pattern" callers and routes/sachiko/sachiko_route.js's
    // buildLabelStockSignature) -- hashes every user-editable field on this
    // schema (productCode, rollType, family, roll/sheet, printing tech, and
    // all six facestock/adhesive/releaseLiner layers), so create/edit is
    // only blocked when a saved row already matches on every one of those
    // fields, not just a similar recipe. `sparse` so pre-existing rows from
    // before this field existed don't collide on a shared `null`.
    labelStockSignature: { type: String, unique: true, sparse: true, trim: true },
    rollType: { type: String, trim: true, enum: ["NORMAL", "DOUBLE RELEASE", "DOUBLE FACESTOCK"], default: "NORMAL" },
    wordFile: { type: String },
    wordFileOriginalName: { type: String },
    family: { type: String, required: true, trim: true },
    // ROLL or SHEET -- determines which Printing Technology options apply.
    // No enum: the create/edit dialogs already constrain this to a fixed
    // <select>, and scripts/migrate-fairdesk-papers-to-label-stock.js needs
    // to seed a TBD-style placeholder here the same way it does for the
    // other required String fields on this schema.
    rollOrSheet: { type: String, required: true, trim: true },
    // SHEET -> DIGITAL, OFFSET. ROLL -> FLEXOGRAPHIC, GRAVURE, LETTER PRESS.
    printingTechnology: { type: String, required: true, trim: true },
    // Only set when printingTechnology is DIGITAL (SHEET only): LASER or INK.
    digitalPrintType: { type: String, trim: true },
    facestock: {
      facestockFamily: { type: String, trim: true },
      facestockType: { type: String, required: true, trim: true },
      facestockMake: { type: String, trim: true },
      facestockVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      facestockVendorName: { type: String, trim: true },
      facestockVendorSkuCode: { type: String, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive: {
      adhesiveType: { type: String, required: true, trim: true },
      adhesiveMake: { type: String, trim: true },
      adhesiveVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      adhesiveVendorName: { type: String, trim: true },
      adhesiveVendorSkuCode: { type: String, trim: true },
      adhesiveShelfLife: { type: String, trim: true },
      adhesiveGsm: { type: Number },
    },
    releaseLiner: {
      releaseLinerType: { type: String, required: true, trim: true },
      releaseLinerMake: { type: String, trim: true },
      releaseLinerVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      releaseLinerVendorName: { type: String, trim: true },
      releaseLinerColor: { type: String, trim: true, default: "WHITE" },
      releaseLinerGsm: { type: Number },
    },
    // Second layer, only populated when rollType calls for it:
    // DOUBLE FACESTOCK -> facestock2 + adhesive2 (two facestock/adhesive pairs, one release liner)
    // DOUBLE RELEASE   -> adhesive2 + releaseLiner2 (one facestock, two adhesive/release-liner pairs)
    facestock2: {
      facestockFamily: { type: String, trim: true },
      facestockType: { type: String, trim: true },
      facestockMake: { type: String, trim: true },
      facestockVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      facestockVendorName: { type: String, trim: true },
      facestockVendorSkuCode: { type: String, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive2: {
      adhesiveType: { type: String, trim: true },
      adhesiveMake: { type: String, trim: true },
      adhesiveVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      adhesiveVendorName: { type: String, trim: true },
      adhesiveVendorSkuCode: { type: String, trim: true },
      adhesiveShelfLife: { type: String, trim: true },
      adhesiveGsm: { type: Number },
    },
    releaseLiner2: {
      releaseLinerType: { type: String, trim: true },
      releaseLinerMake: { type: String, trim: true },
      releaseLinerVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      releaseLinerVendorName: { type: String, trim: true },
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
