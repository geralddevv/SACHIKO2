import mongoose from "mongoose";
import { logDbConnected } from "../utils/startupLog.js";

const connectDB = async () => {
  try {
    let uri = process.env.MONGO_URI;
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;

    if (user && pass) {
      // If credentials are provided, inject them into the URI
      // Matches 'mongodb://' and ensures we don't double-inject '@'
      if (uri.startsWith("mongodb://") && !uri.includes("@")) {
        uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
        
        // Local MongoDB admin users usually reside in the 'admin' database
        if (!uri.includes("authSource")) {
          const separator = uri.includes("?") ? "&" : "?";
          uri += `${separator}authSource=admin`;
        }
      }
    }

    await mongoose.connect(uri);
    logDbConnected("MongoDB connected");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    process.exit(1); // Exit the process with failures
  }
};

export default connectDB;
