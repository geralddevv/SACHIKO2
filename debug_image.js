import mongoose from 'mongoose';
import { configDotenv } from 'dotenv';
import Employee from './models/hr/employee_model.js';

configDotenv();

async function debugImage() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fairtech');
    console.log('Connected to DB');

    const filename = '1780576577047-123079135.jpg';
    const employee = await Employee.findOne({ empPhoto: filename });

    if (employee) {
      console.log('Found employee with photo:', filename);
      console.log('Employee Name:', employee.empName);
      console.log('Employee ID:', employee.empId);
      console.log('Profile Code:', employee.empProfileCode);
    } else {
      console.log('No employee found with empPhoto:', filename);
      
      // Check for partial matches or other cases
      const allWithPhotos = await Employee.find({ empPhoto: { $exists: true, $ne: null } }, 'empName empPhoto empId').limit(10);
      console.log('Sample employees with photos:');
      allWithPhotos.forEach(e => console.log(`- ${e.empName}: "${e.empPhoto}" (ID: ${e.empId})`));
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

debugImage();
