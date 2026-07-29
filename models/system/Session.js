import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    session: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    versionKey: false,
    collection: "sessions",
  },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Session || mongoose.model("Session", sessionSchema);
