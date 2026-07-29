import mongoose from "mongoose";
const { Schema } = mongoose;

const locationDetailSchema = new mongoose.Schema(
  {
    userLocation: { type: String, required: true },
    dispatchAddress: { type: String, required: true },
    // Per-location dispatch details. Only stored when they carry a value:
    // a self-dispatch entry keeps just selfDispatch ("Self Dispatch") and the
    // transport fields are omitted; an unused transport field is omitted too.
    selfDispatch: { type: String },
    transportName: { type: String },
    transportContact: { type: String },
    dropLocation: { type: String },
    deliveryMode: { type: String },
    deliveryLocation: { type: String },
    clientPayment: { type: String },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  clientName: { type: String, required: true },
  clientType: { type: String, required: true },
  hoLocation: { type: String, required: true },
  accountHead: { type: String, required: true },
  userName: { type: String, required: true },
  userLocation: { type: String, required: true },
  userDepartment: { type: String, required: true },
  userContact: { type: String, required: true },
  userEmail: { type: String, required: true },
  dispatchAddress: { type: String, required: true },
  locationsCount: { type: Number, default: 1 },
  locationDetails: [locationDetailSchema],
  transportName: { type: String },
  transportContact: { type: String },
  dropLocation: { type: String },
  deliveryMode: { type: String },
  deliveryLocation: { type: String },
  clientPayment: { type: String },
  SelfDispatch: { type: String },
  clientStatus: { type: String },
  ownerName: { type: String },
  ownerMobNo: { type: String },
  ownerEmail: { type: String },
  clientGst: { type: String },
  clientMsme: { type: String },
  userSignature: { type: String, unique: true, sparse: true, trim: true },

  // Multiple label per client
  label: [
    {
      type: Schema.Types.ObjectId,
      ref: "Label",
    },
  ],
  tape: [
    {
      type: Schema.Types.ObjectId,
      ref: "TapeBinding",
    },
  ],
  posRoll: [
    {
      type: Schema.Types.ObjectId,
      ref: "PosRollBinding",
    },
  ],
  tafeta: [
    {
      type: Schema.Types.ObjectId,
      ref: "TafetaBinding",
    },
  ],
});

const Username = mongoose.model("Username", userSchema);

export default Username;
