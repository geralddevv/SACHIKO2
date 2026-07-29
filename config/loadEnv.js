import { configDotenv } from "dotenv";

// Must be imported before any other local module, and before any other
// import in server.js. ES module imports run in declaration order, and each
// imported module's top-level code executes in full before the next import
// proceeds — several modules (e.g. config/tasksDb.js's getTasksConnection(),
// invoked eagerly by models/miscellaneous/task_model.js and
// models/miscellaneous/daybook_model.js at import time) read
// process.env.MONGO_USER/MONGO_PASS/TASKS_MONGO_URI as soon as they're
// imported. If dotenv hadn't populated process.env yet, those connections
// were silently created without credentials.
configDotenv({ quiet: true });
