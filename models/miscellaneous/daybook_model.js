import mongoose from "mongoose";
import { getTasksConnection } from "../../config/tasksDb.js";

// A Daybook entry is just a "picked up" pointer onto an existing Task — it
// never copies task data. An entry stays in the Daybook until it is explicitly
// rolled back out; dayKey records the calendar day it was picked (kept as
// history, and as part of the uniqueness rule below), but the Daybook page
// reads every entry regardless of day rather than only today's.
const daybookEntrySchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    dayKey: { type: String, required: true, index: true }, // "YYYY-MM-DD", local calendar day
    createdBy: { type: String, required: true, index: true }, // same ownership convention as Task.createdBy
  },
  { timestamps: true },
);

// Same task can't be picked into the same day's daybook twice.
daybookEntrySchema.index({ dayKey: 1, createdBy: 1, task: 1 }, { unique: true });

// Bound to the isolated tasks database connection, same as Task itself.
const DaybookEntry = getTasksConnection().model("DaybookEntry", daybookEntrySchema);

export default DaybookEntry;
