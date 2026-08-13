import mongoose from "mongoose";
import { mediaAssetSchema } from "./mediaAsset.js";

/*
 * A breakdown / problem raised from the shopfloor. An operator photographs the
 * problem on their phone, describes it and submits; the ticket then travels
 * OPEN -> IN PROGRESS -> RESOLVED (or REJECTED) as management works on it.
 * Both sides read the same document: the operator sees the status of their own
 * tickets, management sees every ticket and moves it along.
 */

export const MAINTENANCE_STATUSES = ["OPEN", "IN PROGRESS", "RESOLVED", "REJECTED"];

// Every status change is appended here rather than overwriting the last one,
// so the operator can see what was said at each step, not just where it ended.
const actionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: MAINTENANCE_STATUSES, required: true },
    remark: { type: String, trim: true, default: "" },
    byName: { type: String, trim: true, default: "" },
    byRole: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const maintenanceRequestSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, unique: true },

    // Where the problem is. Resolved at submit time from the operator's own
    // profile code + location (the same code -> machine link the queue uses),
    // so the operator never has to pick a machine on the floor.
    machineName: { type: String, trim: true, uppercase: true, default: "" },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine", default: null },
    locationName: { type: String, trim: true, uppercase: true, default: "" },

    description: { type: String, required: true, trim: true, maxlength: 1000 },

    // Photos and/or a video of the problem, already compressed and thumbnailed
    // by utils/media.js (bucket "maintenance").
    media: { type: [mediaAssetSchema], default: [] },
    // Legacy: the first tickets stored a bare filename under images/maintenance
    // before the shared media store existed. Read-only -- new tickets use media[].
    photo: { type: String, trim: true, default: "" },

    // Who raised it. The name/code are denormalized so the staff list reads
    // without a join and still shows who reported it if the employee record
    // is later renamed or deactivated.
    raisedById: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    raisedByEmpId: { type: String, trim: true, default: "" },
    raisedByName: { type: String, trim: true, default: "" },
    raisedByProfileCode: { type: String, trim: true, default: "" },

    status: { type: String, enum: MAINTENANCE_STATUSES, default: "OPEN", index: true },
    actions: { type: [actionSchema], default: [] },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The staff list is "newest first, optionally filtered by status"; the operator
// list is "my tickets, newest first".
maintenanceRequestSchema.index({ status: 1, createdAt: -1 });
maintenanceRequestSchema.index({ raisedById: 1, createdAt: -1 });

const MaintenanceRequest = mongoose.model("MaintenanceRequest", maintenanceRequestSchema);
export default MaintenanceRequest;
