import mongoose from "mongoose";

// Binds a Label Stock SKU to the Adhesive Master(s) it is allowed to be made
// with.
//
// Why it exists: a recipe's adhesive layer is matched on adhesive TYPE alone
// (utils/labelStockProduction.js's POOL_MATCH_FIELDS) -- deliberately loose,
// since any adhesive of the right type will bond, but not specific enough on
// its own to say which drum is actually correct for a given SKU. A binding is
// what supplies that: Assign Production's Adhesive column only ever offers
// drums of a Label Stock's bound master(s) (routes/sachiko/labelStockProduction.js's
// applyAdhesiveBindings). Mandatory, not opt-in -- a SKU with no binding
// offers nothing rather than guessing at every drum of the recipe's type.
const labelStockAdhesiveBindingSchema = new mongoose.Schema(
  {
    labelStock: { type: mongoose.Schema.Types.ObjectId, ref: "SachikoLabelStock", required: true, index: true },
    adhesive: { type: mongoose.Schema.Types.ObjectId, ref: "AdhesiveMaster", required: true },
    // Identifies "the same binding" -- labelStock + adhesive, hashed the same
    // way as LabelStockBinding's own bindingSignature (see
    // routes/sachiko/labelStockAdhesiveBinding.js).
    bindingSignature: { type: String, unique: true, sparse: true, trim: true },
  },
  { timestamps: true },
);

const LabelStockAdhesiveBinding = mongoose.model(
  "LabelStockAdhesiveBinding",
  labelStockAdhesiveBindingSchema,
  "labelstockadhesivebindings",
);

export default LabelStockAdhesiveBinding;
