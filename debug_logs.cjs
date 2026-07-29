const mongoose = require('mongoose');
require('dotenv').config({ path: __dirname + '/.env' });

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  console.log('Connecting to:', uri);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  // Get all logs
  const allLogs = await db.collection('salesorderlogs').find({}).toArray();
  console.log('\nTotal log count:', allLogs.length);

  const logOrderIds = allLogs.map(l => l.orderId).filter(Boolean);

  // Match in each collection
  const tapeAll = await db.collection('tapesalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1 } }).toArray();
  const labelAll = await db.collection('labelsalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1, labelId: 1 } }).toArray();
  const colorAll = await db.collection('colorlabelsalesorders').find({ _id: { $in: logOrderIds } }, { projection: { _id: 1, onModel: 1, userId: 1, tapeId: 1, colorLabelId: 1 } }).toArray();

  console.log('Tape matches:', tapeAll.length);
  console.log('Label matches:', labelAll.length);
  console.log('ColorLabel matches:', colorAll.length);

  const allMatchIds = new Set([...tapeAll, ...labelAll, ...colorAll].map(o => String(o._id)));
  const orphans = allLogs.filter(l => l.orderId && !allMatchIds.has(String(l.orderId)));
  console.log('\nOrphan logs (orderId exists in log but not in any order collection):', orphans.length);
  orphans.slice(0, 5).forEach(o => console.log(' -', { action: o.action, orderId: String(o.orderId) }));

  // Check if Label orders have userId populated in DB
  if (labelAll.length > 0) {
    console.log('\nLabel order sample:', JSON.stringify(labelAll[0], null, 2));
    // Check the actual label order doc
    const fullLabel = await db.collection('labelsalesorders').findOne({ _id: labelAll[0]._id });
    console.log('Full label order:', JSON.stringify(fullLabel, null, 2));
    
    // Check Username collection
    if (fullLabel && fullLabel.userId) {
      const user = await db.collection('usernames').findOne({ _id: fullLabel.userId });
      console.log('User for this order:', JSON.stringify(user, null, 2));
    }
  }

  // Check a tape order that is in logs
  if (tapeAll.length > 0) {
    const fullTape = await db.collection('tapesalesorders').findOne({ _id: tapeAll[0]._id });
    console.log('\nFull tape order sample:', JSON.stringify({ onModel: fullTape.onModel, userId: fullTape.userId, tapeId: fullTape.tapeId }, null, 2));
  }

  await mongoose.disconnect();
  console.log('\nDone');
}
run().catch(e => { console.error(e); process.exit(1); });
