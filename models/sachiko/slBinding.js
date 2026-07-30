import mongoose from "mongoose";

const slBindingSchema = new mongoose.Schema(
  {
    sl: { type: mongoose.Schema.Types.ObjectId, ref: "SachikoSL", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true },
    location: { type: String, required: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

const SLBinding = mongoose.model("SLBinding", slBindingSchema);

export default SLBinding;
