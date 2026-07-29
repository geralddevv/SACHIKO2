import mongoose from "mongoose";
import { logDbConnected } from "../utils/startupLog.js";

function withAuth(uri) {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

// Points at a sibling database named "<original>_tasks" on the same
// server/cluster as the main app — same credentials, isolated collection
// namespace. Only used as a fallback when TASKS_MONGO_URI isn't set.
function deriveTasksUri(mainUri) {
  const schemeSepIdx = mainUri.indexOf("//");
  if (schemeSepIdx === -1) return mainUri;

  const prefix = mainUri.slice(0, schemeSepIdx + 2);
  const afterScheme = mainUri.slice(schemeSepIdx + 2);
  const pathIdx = afterScheme.indexOf("/");
  if (pathIdx === -1) return `${prefix}${afterScheme}/sachiko_tasks`;

  const hostPart = afterScheme.slice(0, pathIdx);
  const rest = afterScheme.slice(pathIdx + 1);
  const qIdx = rest.indexOf("?");
  const dbName = (qIdx === -1 ? rest : rest.slice(0, qIdx)) || "sachiko";
  const query = qIdx === -1 ? "" : rest.slice(qIdx);

  return `${prefix}${hostPart}/${dbName}_tasks${query}`;
}

// Tasks are private, per-employee data (see sessionOwnerKey in
// fairdesk_route.js) — they live in their own MongoDB database, separate
// from the main app database, so they're isolated at the storage layer too
// (different backup/restore scope, and can be locked down with its own
// database-level access control independent of the rest of the app).
let tasksConnection = null;

export function getTasksConnection() {
  if (tasksConnection) return tasksConnection;

  const mainUri = process.env.MONGO_URI || "mongodb://localhost:27017/sachiko";
  const uri = withAuth(process.env.TASKS_MONGO_URI || deriveTasksUri(mainUri));

  tasksConnection = mongoose.createConnection(uri);
  tasksConnection.on("connected", () => logDbConnected("Tasks DB connected"));
  tasksConnection.on("error", (err) => console.error("Error connecting to Tasks MongoDB:", err));

  return tasksConnection;
}
