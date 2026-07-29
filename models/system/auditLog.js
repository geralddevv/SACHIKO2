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
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ username: 1, createdAt: -1 });

export default mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
