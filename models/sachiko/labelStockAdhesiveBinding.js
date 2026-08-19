import mongoose from "mongoose";

// Binds a Label Stock SKU to the Adhesive Master(s) it is allowed to be made
// with.
//
// Why it exists: a recipe's adhesive layer is matched on adhesive TYPE alone
// (utils/labelStockProduction.js's POOL_MATCH_FIELDS) -- deliberately loose,
// since any adhesive of the right type will bond. That means Assign
// Production's Adhesive column offers every drum of that type at the machine's
// location, which is more choice than some SKUs should have. A binding narrows
// it: once a Label Stock has at least one ACTIVE binding, only drums of a bound
// master are offered for it. A SKU with no bindings is unaffected and keeps the
// full type-matched list, so this is opt-in per SKU rather than a gate everyone
// has to fill in first.
//
// `location` is optional -- blank means the binding holds everywhere, which is
// the common case. Set it to scope a binding to one unit (e.g. only UNIT 2
// stocks the imported adhesive that SKU needs).
const labelStockAdhesiveBindingSchema = new mongoose.Schema(
  {
    labelStock: { type: mongoose.Schema.Types.ObjectId, ref: "SachikoLabelStock", required: true, index: true },
    adhesive: { type: mongoose.Schema.Types.ObjectId, ref: "AdhesiveMaster", required: true },
    location: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
    // Identifies "the same binding" -- labelStock + adhesive + location,
    // hashed the same way as LabelStockBinding's own bindingSignature (see
    // routes/sachiko/labelStockAdhesiveBinding.js). Location IS part of it
    // here: the same adhesive bound once globally and once to UNIT 2 are two
    // different statements, and neither is a typo of the other.
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
