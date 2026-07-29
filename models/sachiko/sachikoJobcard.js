import mongoose from "mongoose";

const sachikoJobcardSchema = new mongoose.Schema(
  {
    jobCardId: { type: String, required: true, unique: true },
    date: { type: Date, required: true },
    productCode: { type: String, required: true, trim: true },
    quantity: { type: Number },
    lotNo: { type: String, trim: true },
    machineNo: { type: String, trim: true },
    operatorName: { type: String, trim: true },
    helperName: { type: String, trim: true },
    faceStock: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    adhesive: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    releaseLiner: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    jobSetting: [{
      mtrs1:     { type: Number },
      startTime: { type: String, trim: true },
      mtrs2:     { type: Number },
      stopTime:  { type: String, trim: true },
    }],
    productionLog: [{
      deckleId:  { type: String, trim: true },
      meters:    { type: Number },
      face:    { joint: { type: String, trim: true }, mtr: { type: Number } },
      release: { joint: { type: String, trim: true }, mtr: { type: Number } },
      time:    { startTime: { type: String, trim: true }, endTime: { type: String, trim: true } },
    }],
    totalMeter: { type: String, trim: true },
    sqMtr:      { type: String, trim: true },
  },
  { timestamps: true },
);

const SachikoJobcard = mongoose.model(
  "SachikoJobcard",
  sachikoJobcardSchema,
  "jobcards",
);

export default SachikoJobcard;
