import mongoose from "mongoose";

const labelStockBindingSchema = new mongoose.Schema(
  {
    labelStock: { type: mongoose.Schema.Types.ObjectId, ref: "SachikoLabelStock", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true },
    location: { type: String, required: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

const LabelStockBinding = mongoose.model("LabelStockBinding", labelStockBindingSchema, "labelstockbindings");

export default LabelStockBinding;
