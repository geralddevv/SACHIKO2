import mongoose from "mongoose";

const sachikoSalesOrderSchema = new mongoose.Schema(
  {
    salesOrderId: { type: String, required: true, unique: true },
    date:         { type: Date, required: true },
    clientName:     { type: String, required: true, trim: true },
    clientUserName: { type: String, trim: true },
    productCode:    { type: String, required: true, trim: true },
    deckleType:     { type: String, trim: true },
    faceStock: {
      code:      { type: String, trim: true },
      gsmMic:    { type: String, trim: true },
      size:      { type: String, trim: true },
      rollDrumNo:{ type: String, trim: true },
    },
    adhesive: {
      code:      { type: String, trim: true },
      gsmMic:    { type: String, trim: true },
      size:      { type: String, trim: true },
      rollDrumNo:{ type: String, trim: true },
    },
    releaseLiner: {
      code:      { type: String, trim: true },
      gsmMic:    { type: String, trim: true },
      size:      { type: String, trim: true },
      rollDrumNo:{ type: String, trim: true },
    },
  },
  { timestamps: true },
);

const SachikoSalesOrder = mongoose.model(
  "SachikoSalesOrder",
  sachikoSalesOrderSchema,
  "salesorders",
);

export default SachikoSalesOrder;
