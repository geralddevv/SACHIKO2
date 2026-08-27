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

  await PendingProduction.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        onModel: order.onModel,
        itemId,
        userId: order.userId,
        quantity: order.quantity,
        dispatchedQuantity: order.dispatchedQuantity || 0,
        poNumber: order.poNumber,
        deckleOption: order.deckleOption,
        orderRate: order.orderRate,
        estimatedDate: order.estimatedDate,
        remarks: order.remarks,
        paperSize: order.paperSize,
        runningMeters: order.runningMeters,
        noOfRolls: order.noOfRolls,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

export async function removePendingProduction(orderId) {
  if (!orderId) return;
  await PendingProduction.deleteOne({ _id: orderId });

  // Detach the order from any SKU-batch that still lists it (see the
  // isDeckleBatch fields in models/inventory/pendingProduction.js). Members are
  // normally frozen once batched, but an order dispatched/cancelled out of band
  // would otherwise leave a dangling ref. Drop a still-unassigned batch that is
  // left with no members at all.
  const batches = await PendingProduction.find({
    isDeckleBatch: true,
    batchOrderIds: orderId,
  }).select("_id assignedMachineId batchOrderIds").lean();
  for (const batch of batches) {
    const remaining = (batch.batchOrderIds || []).filter((id) => String(id) !== String(orderId));
    if (remaining.length === 0 && !batch.assignedMachineId) {
      await PendingProduction.deleteOne({ _id: batch._id });
    } else {
      await PendingProduction.updateOne({ _id: batch._id }, { $pull: { batchOrderIds: orderId } });
    }
  }
}
