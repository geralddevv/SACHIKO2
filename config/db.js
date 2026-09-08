import mongoose from "mongoose";
import { logDbConnected } from "../utils/startupLog.js";

// Build the effective connection URI from the environment, injecting
// credentials the same way whether we connect at boot or reconnect later.
export const buildMongoUri = () => {
  let uri = process.env.MONGO_URI;
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;

  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    // Local MongoDB admin users usually reside in the 'admin' database
    if (!uri.includes("authSource")) {
      uri += `${uri.includes("?") ? "&" : "?"}authSource=admin`;
    }
  }
  return uri;
};

const connectDB = async () => {
  try {
    await mongoose.connect(buildMongoUri());
    logDbConnected("MongoDB connected");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    process.exit(1); // Exit the process with failures
  }
};

// Re-point the app at whatever process.env.MONGO_URI now says. Used when the
// company is renamed and its data moves to a new database (utils/companyDb.js).
// Closes and re-opens the SAME default connection object -- mongoose.disconnect()
// + connect() leaves the registered models bound to the dead connection.
// Throws on failure so the caller can roll back.
export const reconnectDB = async () => {
  await mongoose.connection.close();
  await mongoose.connection.openUri(buildMongoUri());
  logDbConnected("MongoDB reconnected");
};

export default connectDB;
