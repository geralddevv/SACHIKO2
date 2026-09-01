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
  },
  { timestamps: true },
);

const Company = mongoose.model("Company", companySchema);
export default Company;
