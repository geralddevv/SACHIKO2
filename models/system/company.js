import mongoose from "mongoose";
import { mediaAssetSchema } from "./mediaAsset.js";

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

    // The code every id this installation generates starts with:
    // "SP | FCS | 000001", "SP | LOT | 0042". Suggested from the company name
    // (suggestIdPrefix in utils/companyBrand.js) but typed, because a
    // company's short code is a fact about the company, not something a rule
    // can guess -- Zactac call themselves ZC, which no derivation produces.
    // Blank falls back to that suggestion, so an installation that never
    // touches this field behaves exactly as it always did.
    // Changing it never rewrites an id already in the database; ids are
    // opaque strings here and nothing parses one back apart.
    // Every URL prefix this company has been served under, oldest first. The
    // prefix is the first word of the name (slugifyCompany), so renaming the
    // company moves the whole app to a new one -- and every bookmark, open tab
    // and pasted link on the old prefix would 404. brandPrefix.js redirects
    // those here instead. Capped and deduped in routes/system/company.js.
    slugHistory: {
      type: [String],
      default: [],
    },
    idPrefix: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      match: [/^([A-Z0-9]{2,4})?$/, "The ID code must be 2-4 letters or digits."],
    },

    // Optional company logo (utils/media.js pipeline, bucket "company"). When
    // absent the app falls back to the first letter of companyName -- see
    // /company/favicon in server.js and the logo box in companyMaster.ejs.
    logo: {
      type: mediaAssetSchema,
      default: null,
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
