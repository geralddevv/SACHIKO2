import mongoose from "mongoose";

const calculatorSchema = new mongoose.Schema({}, { strict: false });

// Sparse so Rate/Sales Calculator submissions (which never set prodSignature)
// don't collide with each other under this index — only Production Binding
// submissions populate this field.
calculatorSchema.index({ prodSignature: 1 }, { unique: true, sparse: true });

const Calculator = mongoose.model("Calculator", calculatorSchema);

export default Calculator;