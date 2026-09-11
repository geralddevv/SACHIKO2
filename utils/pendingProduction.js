import PendingProduction from "../models/inventory/pendingProduction.js";

/*
 * Keeps the PendingProduction collection in sync with Label Stock sales
 * orders. Call upsertPendingProduction whenever an order becomes/stays
 * PENDING (create, edit, or a partial dispatch that leaves quantity
 * remaining); call removePendingProduction the moment it stops being PENDING
 * (confirmed/fully dispatched, or cancelled).
 *
 * `order` must have: _id, onModel ("SachikoLabelStock"), tapeId, userId,
 * quantity, dispatchedQuantity, poNumber, orderRate, estimatedDate, remarks,
 * paperSize, runningMeters, noOfRolls -- i.e. a TapeSalesOrder document
 * (lean or full) for a Label Stock order. Plain Tape orders (onModel
 * "Tape") never reach this pipeline -- this is a no-op for them.
 */
export async function upsertPendingProduction(order) {
  if (!order || order.onModel !== "SachikoLabelStock") return;

  const itemId = order.tapeId;
  if (!itemId || !order.userId) return;

  // A deckle that only partly covered this order will have split the balance
  // off into remainder rows (parentOrderId -> this order; see
  // models/inventory/pendingProduction.js). The order's quantity is then spread
  // across the family, so it must not be written wholesale onto the parent.
  const remainders = await PendingProduction.find({ parentOrderId: order._id })
    .select("_id quantity deckleBatchId assignedMachineId")
    .sort({ createdAt: 1 })
    .lean();

  const shared = {
    onModel: order.onModel,
    itemId,
    userId: order.userId,
    dispatchedQuantity: order.dispatchedQuantity || 0,
    poNumber: order.poNumber,
    deckleOption: order.deckleOption,
    orderRate: order.orderRate,
    estimatedDate: order.estimatedDate,
    remarks: order.remarks,
    paperSize: order.paperSize,
    runningMeters: order.runningMeters,
  };

  if (!remainders.length) {
    await PendingProduction.findOneAndUpdate(
      { _id: order._id },
      { $set: { ...shared, quantity: order.quantity, noOfRolls: order.noOfRolls } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    return;
  }

  // Everything except the quantities, which the split owns.
  await PendingProduction.updateOne({ _id: order._id }, { $set: shared }, { upsert: true });
  await PendingProduction.updateMany({ parentOrderId: order._id }, { $set: shared });
  await reconcileSplitQuantity(order, remainders);
}

// Push a sales-order quantity change onto a split family: the loose remainder
// rows absorb it first (they are the part nobody has started on), and only
// what they cannot absorb touches the parent -- and then only while the parent
// is still loose itself. Rolls already batched or on a machine are never
// silently resized; anything left over is simply not applied, and the order's
// own record stays the authority.
async function reconcileSplitQuantity(order, remainders) {
  const parent = await PendingProduction.findById(order._id)
    .select("quantity deckleBatchId assignedMachineId")
    .lean();
  if (!parent) return;

  const target = Number(order.quantity) || 0;
  const loose = remainders.filter((r) => !r.deckleBatchId && !r.assignedMachineId);
  let delta = target - (Number(parent.quantity) || 0)
    - remainders.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
  if (!delta) return;

  if (delta > 0) {
    // Grown: add to the first loose remainder, else give the parent the extra.
    const target0 = loose[0];
    if (target0) {
      await PendingProduction.updateOne(
        { _id: target0._id },
        { $inc: { quantity: delta } },
      );
    } else if (!parent.deckleBatchId && !parent.assignedMachineId) {
      await PendingProduction.updateOne({ _id: parent._id }, { $inc: { quantity: delta } });
    }
    return;
  }

  // Shrunk: take it off the loose remainders (newest first -- they are the
  // furthest from being made), deleting any that reach zero.
  let owed = -delta;
  for (const r of loose.slice().reverse()) {
    if (owed <= 0) break;
    const have = Number(r.quantity) || 0;
    const cut = Math.min(have, owed);
    owed -= cut;
    if (cut >= have) await PendingProduction.deleteOne({ _id: r._id });
    else await PendingProduction.updateOne({ _id: r._id }, { $inc: { quantity: -cut } });
  }
  if (owed > 0 && !parent.deckleBatchId && !parent.assignedMachineId) {
    await PendingProduction.updateOne(
      { _id: parent._id },
      { $set: { quantity: Math.max(0, (Number(parent.quantity) || 0) - owed) } },
    );
  }
}

export async function removePendingProduction(orderId) {
  if (!orderId) return;
  // Remainder rows split off this order (parentOrderId) are part of the same
  // order -- they go with it, and are detached from any batch alongside it.
  const remainderIds = (await PendingProduction.find({ parentOrderId: orderId })
    .select("_id")
    .lean()).map((r) => r._id);
  await PendingProduction.deleteMany({ _id: { $in: [orderId, ...remainderIds] } });

  // Detach the order from any SKU-batch that still lists it (see the
  // isDeckleBatch fields in models/inventory/pendingProduction.js). Members are
  // normally frozen once batched, but an order dispatched/cancelled out of band
  // would otherwise leave a dangling ref. Drop a still-unassigned batch that is
  // left with no members at all.
  const gone = [orderId, ...remainderIds];
  const batches = await PendingProduction.find({
    isDeckleBatch: true,
    batchOrderIds: { $in: gone },
  }).select("_id assignedMachineId batchOrderIds").lean();
  for (const batch of batches) {
    const remaining = (batch.batchOrderIds || [])
      .filter((id) => !gone.some((g) => String(g) === String(id)));
    if (remaining.length === 0 && !batch.assignedMachineId) {
      await PendingProduction.deleteOne({ _id: batch._id });
    } else {
      await PendingProduction.updateOne(
        { _id: batch._id },
        { $pull: { batchOrderIds: { $in: gone } } },
      );
    }
  }
}
