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
    // Material-only counterpart to labelStockSignature above -- just the six
    // facestock/adhesive/releaseLiner layers (see buildMaterialSignature in
    // utils/labelStockVariant.js for the exact field list), none of the
    // product-level fields. NOT unique: two label stocks legitimately sharing
    // this hash just means they're the same physical material stack under
    // different Product Codes, not a duplicate. Consumed by another module as
    // a stable "same material stack" key -- index for lookup, but don't
    // change its shape/field list without also re-running
    // scripts/backfill-labelstock-material-signature.js.
    materialSignature: { type: String, trim: true, index: true },
    rollType: { type: String, trim: true, enum: ["NORMAL", "DOUBLE RELEASE", "DOUBLE FACESTOCK"], default: "NORMAL" },
    // Two separate attachment slots -- wordFile takes only .doc/.docx,
    // pdfFile only .pdf (see fileFilter in routes/sachiko/sachiko_route.js).
    // Before this split both lived in wordFile regardless of extension; see
    // scripts/backfill-labelstock-pdf-field.js for the one-time move of
    // already-saved *.pdf rows out of wordFile into here.
    wordFile: { type: String },
    wordFileOriginalName: { type: String },
    pdfFile: { type: String },
    pdfFileOriginalName: { type: String },
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
      // Facestock Master's own Size wasn't captured here at all until this
      // field was added -- Family/Type/Make/Vendor/Vendor SKU Code/GSM/Micron
      // alone can't tell apart two masters that differ only in Size (a real
      // case in this data: three Facestock Masters sharing everything else),
      // so matching (routes/stock/facestockStock.js's facestockRecipeKey,
      // utils/labelStockProduction.js's POOL_MATCH_FIELDS) stayed ambiguous
      // between them until now. Blank on a row saved before this field
      // existed -- reelMatchesLayer() treats a blank recipe field as "no
      // constraint", so an old row just stays as ambiguous as before until
      // it's re-saved with a Size picked.
      facestockSize: { type: String, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive: {
      adhesiveType: { type: String, required: true, trim: true },
      adhesiveMake: { type: String, trim: true },
      adhesiveVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      adhesiveVendorName: { type: String, trim: true },
      adhesiveVendorSkuCode: { type: String, trim: true },
      // Adhesive Master's own Viscosity/Cohesion/Shear/Density weren't
      // captured here at all until these fields were added -- same gap as
      // facestockSize below: Type/Make/Vendor/Vendor SKU Code
      // alone can't tell apart two Adhesive Masters that differ only in one
      // of these four physical properties, so matching (routes/stock/
      // adhesiveStock.js's adhesiveRecipeKey, utils/labelStockProduction.js's
      // POOL_MATCH_FIELDS) stayed ambiguous between them. Blank on a row
      // saved before these fields existed -- reelMatchesLayer() treats a
      // blank recipe field as "no constraint", so an old row just stays as
      // ambiguous as before until it's re-saved with values picked.
      adhesiveViscosity: { type: Number },
      adhesiveCohesion: { type: Number },
      adhesiveShear: { type: Number },
      adhesiveDensity: { type: Number },
      adhesiveGsm: { type: Number },
    },
    releaseLiner: {
      releaseLinerType: { type: String, required: true, trim: true },
      releaseLinerMake: { type: String, trim: true },
      // Mirrors Release Master's own `sensing` (models/inventory/
      // releaseMaster.js) -- whether the liner carries the sensing mark the
      // press's eye-mark sensor needs. A property of the material, so it's
      // part of the recipe like every other layer field, and part of both
      // labelStockSignature and materialSignature (utils/labelStockVariant.js).
      // Blank both on rows saved before this field existed AND on any recipe
      // whose Release Master hasn't had Sensing filled in yet -- the create/
      // edit dialog's cascade offers only the values the master data actually
      // holds, so "not stated" stays a first-class value here.
      releaseLinerSensing: { type: String, trim: true, uppercase: true, enum: ["SENSING", "NON-SENSING", ""] },
      releaseLinerVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      releaseLinerVendorName: { type: String, trim: true },
      // Release Master's own Vendor SKU Code/Size weren't captured here at
      // all until these fields were added -- same gap as facestockSize
      // above/adhesiveViscosity etc. above.
      releaseLinerVendorSkuCode: { type: String, trim: true },
      releaseLinerColor: { type: String, trim: true, default: "WHITE" },
      releaseLinerSize: { type: String, trim: true },
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
      facestockSize: { type: String, trim: true },
      facestockGsm: { type: Number },
      facestockMicron: { type: Number },
    },
    adhesive2: {
      adhesiveType: { type: String, trim: true },
      adhesiveMake: { type: String, trim: true },
      adhesiveVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      adhesiveVendorName: { type: String, trim: true },
      adhesiveVendorSkuCode: { type: String, trim: true },
      adhesiveViscosity: { type: Number },
      adhesiveCohesion: { type: Number },
      adhesiveShear: { type: Number },
      adhesiveDensity: { type: Number },
      adhesiveGsm: { type: Number },
    },
    releaseLiner2: {
      releaseLinerType: { type: String, trim: true },
      releaseLinerMake: { type: String, trim: true },
      // See releaseLiner.releaseLinerSensing above.
      releaseLinerSensing: { type: String, trim: true, uppercase: true, enum: ["SENSING", "NON-SENSING", ""] },
      releaseLinerVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
      releaseLinerVendorName: { type: String, trim: true },
      releaseLinerVendorSkuCode: { type: String, trim: true },
      releaseLinerColor: { type: String, trim: true, default: "WHITE" },
      releaseLinerSize: { type: String, trim: true },
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
