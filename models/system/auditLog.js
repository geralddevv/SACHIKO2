import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    username: { type: String },
    empName: { type: String },
    profileCode: { type: String },
    role: { type: String },
    action: { type: String, required: true }, // LOGIN, LOGOUT, CREATE, UPDATE, DELETE
    method: { type: String, required: true },
    path: { type: String, required: true },
    description: { type: String }, // human-readable "what happened" (e.g. Created client "X")
    statusCode: { type: Number },
    ip: { type: String },
    // Where the person physically was, as reported by their device. Only the
    // mobile operator app fills this in (the web portal has no equivalent), and
    // only on LOGIN -- see logAuthEvent in middleware/auditLogger.js. Capture
    // is best-effort on the device, so `error` ("denied" | "timeout" |
    // "unavailable") stands in for the coordinates when the tablet couldn't get
    // a fix; exactly one of the two sides is ever populated.
    geo: {
      lat: { type: Number },
      lng: { type: Number },
      accuracy: { type: Number }, // metres of uncertainty on the fix above
      error: { type: String },
    },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ username: 1, createdAt: -1 });

export default mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
