import mongoose from "mongoose";

// Company master -- the single registration record describing the company
// this installation belongs to (letterheads, printed documents, etc.).
// Deliberately a singleton: `singleton` is a constant-valued unique key, so
// the database itself refuses a second company row no matter which route or
// script tries to insert one. The record is created once and edited from
// then on -- there is no delete.
const companySchema = new mongoose.Schema(
  {
    singleton: {
      type: String,
      default: "COMPANY",
      enum: ["COMPANY"],
      unique: true,
      immutable: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
    },
    telephone: {
      type: String,
      trim: true,
      default: "",
    },
    mobile: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },

    // Statutory registration numbers -- mirror the client master's fields so a
    // company's own documents can carry the same identifiers.
    gst: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    msme: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    gumasta: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    pan: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },

    // Bank details for the company's own account (printed on invoices, used
    // for incoming payments). All optional -- filled in when known.
    bankDetails: {
      bankName: { type: String, trim: true, uppercase: true, default: "" },
      accountHolderName: { type: String, trim: true, uppercase: true, default: "" },
      accountNumber: { type: String, trim: true, default: "" },
      ifsc: { type: String, trim: true, uppercase: true, default: "" },
      branch: { type: String, trim: true, uppercase: true, default: "" },
    },
  },
  { timestamps: true },
);

const Company = mongoose.model("Company", companySchema);
export default Company;
