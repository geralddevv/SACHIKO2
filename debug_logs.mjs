import mongoose from 'mongoose';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
console.log('Connecting to:', uri);
await mongoose.connect(uri);
const db = mongoose.connection.db;

// Fetch ALL logs
const allLogs = await db.collection('salesorderlogs').find({}).toArray();
console.log('\nTotal salesorderlogs count:', allLogs.length);

const logOrderIds = allLogs.map(l => l.orderId).filter(Boolean);
const uniqueOrderIds = [...new Set(logOrderIds.map(String))];
console.log('Unique orderIds referenced by logs:', uniqueOrderIds.length);

// Match against each collection
const tapeAll = await db.collection('tapesalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1 } }).toArray();
const labelAll = await db.collection('labelsalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1, labelId: 1 } }).toArray();
const colorAll = await db.collection('colorlabelsalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1, colorLabelId: 1 } }).toArray();

console.log('Tape matches:', tapeAll.length);
console.log('Label matches:', labelAll.length);
console.log('ColorLabel matches:', colorAll.length);

const allMatchIds = new Set([...tapeAll, ...labelAll, ...colorAll].map(o => String(o._id)));
const orphanLogs = allLogs.filter(l => l.orderId && !allMatchIds.has(String(l.orderId)));
console.log('\nOrphan logs (orderId not found in ANY order collection):', orphanLogs.length);
orphanLogs.slice(0, 10).forEach(o => console.log(' - action:', o.action, '| orderId:', String(o.orderId)));

// Show a label order to check userId/tapeId fields
if (labelAll.length > 0) {
  const fullLabel = await db.collection('labelsalesorders').findOne({ _id: labelAll[0]._id });
  console.log('\nFull Label order sample:');
  console.log('  userId:', String(fullLabel.userId || '(empty)'));
  console.log('  tapeId:', String(fullLabel.tapeId || '(empty)'));
  console.log('  labelId:', String(fullLabel.labelId || '(empty)'));
  console.log('  onModel:', fullLabel.onModel);
  
  // Check the user record
  if (fullLabel.userId) {
    const user = await db.collection('usernames').findOne({ _id: fullLabel.userId }, { projection: { clientName: 1, userName: 1 } });
    console.log('  User record:', JSON.stringify(user));
  }
  
  // Check the label record
  if (fullLabel.tapeId) {
    const labelItem = await db.collection('labelsbinding').findOne({ _id: fullLabel.tapeId }, { projection: { labelWidth: 1, labelHeight: 1 } });
    console.log('  Label item:', JSON.stringify(labelItem));
  }
}

// Check what model the TapeSalesOrder uses for onModel and check a few tape logs
if (tapeAll.length > 0) {
  const fullTape = await db.collection('tapesalesorders').findOne({ _id: tapeAll[0]._id });
  console.log('\nFull Tape order sample:');
  console.log('  userId:', String(fullTape.userId || '(empty)'));
  console.log('  tapeId:', String(fullTape.tapeId || '(empty)'));
  console.log('  onModel:', fullTape.onModel);

  if (fullTape.userId) {
    const user = await db.collection('usernames').findOne({ _id: fullTape.userId }, { projection: { clientName: 1, userName: 1 } });
    console.log('  User record:', JSON.stringify(user));
  }
}

await mongoose.disconnect();
console.log('\nDone.');
