import mongoose from "mongoose";

// Board Paper master -- the list of board paper grades the plant buys
// (FBB, SBS, kraft-back and so on). A lookup master in the same shape as
// models/system/family.js and models/system/type.js: a name and nothing
// else, kept so the grades can be maintained from the Masters tab instead
// of being typed afresh every time.
//
// Deliberately NOT one of the spec masters (Facestock / Adhesive / Release /
// Core). Those carry a vendor, a spec, a minted "SP | XXX | 000001" id and a
// sha256 duplicate signature because a row of theirs is a thing you hold in
// stock; this is a vocabulary, so the name IS the identity and the unique
// index on it is the whole duplicate check.
const boardPaperSchema = new mongoose.Schema(
  {
    boardPaperName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const BoardPaper = mongoose.model("BoardPaper", boardPaperSchema);
export default BoardPaper;
