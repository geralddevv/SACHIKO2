import mongoose from "mongoose";
import { getTasksConnection } from "../../config/tasksDb.js";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    // Every task has exactly one responsible person — usually a real Employee,
    // but assignedToIsOthers lets it be a free-text name (assignedToOthers)
    // for someone not in the Employee list.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    assignedToIsOthers: { type: Boolean, default: false },
    assignedToOthers: { type: String, trim: true },
    // Optional — a task doesn't have to be tied to a client/company. Same
    // Others pattern as assignedTo, for a client not in the Client list.
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
    clientIsOthers: { type: Boolean, default: false },
    clientOthers: { type: String, trim: true },
    dueDate: { type: Date },
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "COMPLETED"],
      default: "PENDING",
      index: true,
    },
    createdBy: { type: String, trim: true },
    // Soft-delete: set instead of removing the document, so a mis-click doesn't
    // permanently destroy the task. Hidden from normal queries via deletedAt: null.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Bound to the isolated tasks database connection (config/tasksDb.js)
// instead of the default mongoose connection — task data is kept in a
// physically separate database from the rest of the app.
const Task = getTasksConnection().model("Task", taskSchema);

export default Task;
