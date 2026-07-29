import mongoose from "mongoose";
import { configDotenv } from "dotenv";
import Employee from "./models/hr/employee_model.js";

configDotenv();

const checkEmployee = async () => {
  try {
    let uri = process.env.MONGO_URI;
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;

    if (user && pass) {
      if (uri.startsWith("mongodb://") && !uri.includes("@")) {
        uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
        if (!uri.includes("authSource")) {
          const separator = uri.includes("?") ? "&" : "?";
          uri += `${separator}authSource=admin`;
        }
      }
    }

    await mongoose.connect(uri);
    console.log("Connected to DB");

    const employees = await Employee.find({ empPhoto: { $exists: true, $ne: null } }).limit(5);
    console.log("Employees with photos:");
    employees.forEach(e => {
      console.log(`- ${e.empName} (ID: ${e.empId}): "${e.empPhoto}"`);
    });

    if (employees.length === 0) {
        console.log("No employees found with photos.");
        const anyEmployee = await Employee.findOne();
        if (anyEmployee) {
            console.log("Example employee without photo:");
            console.log(JSON.stringify(anyEmployee, null, 2));
        } else {
            console.log("No employees found in DB at all.");
        }
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error("Error:", error);
  }
};

checkEmployee();
