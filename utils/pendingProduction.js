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
    // Only a brand-new order can take over an advance order -- an edit or a
    // partial dispatch re-entering PENDING already has its row.
    const isNew = !(await PendingProduction.exists({ _id: order._id }));
    await PendingProduction.findOneAndUpdate(
      { _id: order._id },
      { $set: { ...shared, quantity: order.quantity, noOfRolls: order.noOfRolls } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    if (isNew) return absorbAdvanceOrders(order, shared);
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

// ---- Advance orders ---------------------------------------------------------
// An advance order (PendingProduction.isAdvance) is a need the planner typed in
// on Deckle Sorting before any sales order existed, so its rolls could be cut
// into a deckle early. When the real order for it lands, the real order takes
// its place -- otherwise the same rolls would sit on Deckle Sorting twice and be
// made twice, and the batch would stay flagged ADVANCE for rolls a client has
// in fact ordered.
//
// A match is the same Product Code + Paper Size + Running Mtrs (one roll's
// length -- 1000 m rolls are not 500 m rolls). Advance rows already in a batch
// are taken first (that is material already planned or made for this order),
// then loose ones, oldest first within each.
//
//   - a BATCHED advance row hands its rolls to the order: the order's own row
//     joins that batch for the first one (a clone, parentOrderId = the order,
//     for any further batch -- the device the batch POST uses), and the
//     advance row shrinks by as much, or goes;
//   - a LOOSE advance row just shrinks (or goes): nothing was set for it, the
//     real order's own loose row now stands for those rolls;
//   - whatever the order wants beyond the advance stays loose as normal.
//
// Called by upsertPendingProduction only when the order's row was just made,
// so an edit can never re-absorb. `shared` is the order's sync fields.
// Returns { batchedRolls, looseRolls } for a caller that wants to say so.
const sameNum = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;

export async function absorbAdvanceOrders(order, shared) {
  const size = Number(order.paperSize);
  const qty = Number(order.quantity) || 0;
  if (!(size > 0) || !(qty > 0)) return null;

  const advances = (await PendingProduction.find({
    isAdvance: true,
    itemId: shared.itemId,
    quantity: { $gt: 0 },
  }).lean())
    .filter((a) => sameNum(a.paperSize, size) && sameNum(a.runningMeters, order.runningMeters))
    .sort((a, b) => (a.deckleBatchId ? 0 : 1) - (b.deckleBatchId ? 0 : 1)
      || new Date(a.createdAt) - new Date(b.createdAt));
  if (!advances.length) return null;

  const scaleRolls = (part) => (Number(order.noOfRolls) > 0
    ? Math.max(1, Math.round((Number(order.noOfRolls) * part) / qty))
    : undefined);

  let left = qty;
  let looseRolls = 0;
  const batchedTakes = [];
  for (const a of advances) {
    if (left <= 0) break;
    const have = Number(a.quantity) || 0;
    const take = Math.min(left, have);
    if (take <= 0) continue;
    left -= take;
    if (a.deckleBatchId) batchedTakes.push({ a, take });
    else looseRolls += take;

    if (take >= have) {
      await PendingProduction.deleteOne({ _id: a._id });
      if (a.deckleBatchId) {
        await PendingProduction.updateOne(
          { _id: a.deckleBatchId },
          { $pull: { batchOrderIds: a._id } },
        );
      }
    } else {
      const rolls = Number(a.noOfRolls) > 0
        ? { noOfRolls: Math.max(1, Math.round((Number(a.noOfRolls) * (have - take)) / have)) }
        : {};
      await PendingProduction.updateOne(
        { _id: a._id },
        { $set: { quantity: have - take, ...rolls } },
      );
    }
  }

  if (!batchedTakes.length) return { batchedRolls: 0, looseRolls };

  // The order's rolls that land in a batch come off its loose row; the rest
  // (loose advance rolls it replaced + anything it wants beyond the advance)
  // stay loose on a remainder row, exactly the shape a part-set order has.
  const joinBatch = async (memberId, a) => {
    const batch = await PendingProduction.findById(a.deckleBatchId)
      .select("userId poNumber")
      .lean();
    await PendingProduction.updateOne(
      { _id: a.deckleBatchId },
      {
        $addToSet: { batchOrderIds: memberId },
        // A batch made only of advance rows has no client or PO of its own --
        // the first real order to join it supplies them.
        ...(!batch?.userId || !batch?.poNumber
          ? {
              $set: {
                ...(!batch?.userId ? { userId: order.userId } : {}),
                ...(!batch?.poNumber && order.poNumber ? { poNumber: order.poNumber } : {}),
              },
            }
          : {}),
      },
    );
  };

  const [first, ...rest] = batchedTakes;
  await PendingProduction.updateOne(
    { _id: order._id },
    {
      $set: {
        quantity: first.take,
        ...(scaleRolls(first.take) != null ? { noOfRolls: scaleRolls(first.take) } : {}),
        deckleBatchId: first.a.deckleBatchId,
        deckleSize: first.a.deckleSize,
      },
    },
  );
  await joinBatch(order._id, first.a);

  for (const { a, take } of rest) {
    const clone = await PendingProduction.create({
      ...shared,
      parentOrderId: order._id,
      quantity: take,
      noOfRolls: scaleRolls(take),
      deckleBatchId: a.deckleBatchId,
      deckleSize: a.deckleSize,
    });
    await joinBatch(clone._id, a);
  }

  const batchedRolls = batchedTakes.reduce((n, t) => n + t.take, 0);
  const stillLoose = Math.round((qty - batchedRolls) * 100) / 100;
  if (stillLoose > 0) {
    await PendingProduction.create({
      ...shared,
      parentOrderId: order._id,
      quantity: stillLoose,
      noOfRolls: scaleRolls(stillLoose),
    });
  }
  return { batchedRolls, looseRolls };
}

// How much of each deckle batch is still advance (no sales order behind it
// yet), so every page a batch travels through -- Deckle Queue, Assign
// Production, WIP, the machine/operator queues and the operator app -- can
// flag it until the real order takes it over. Read live off the member rows
// rather than stored on the batch, so the flag clears by itself the moment
// absorbAdvanceOrders() hands the rolls over.
// Returns Map<batchId string, { rolls, orders }>.
export async function advanceShareByBatch(batchIds) {
  const ids = (batchIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await PendingProduction.aggregate([
    { $match: { isAdvance: true, deckleBatchId: { $in: ids } } },
    { $group: { _id: "$deckleBatchId", rolls: { $sum: "$quantity" }, orders: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { rolls: r.rolls, orders: r.orders }]));
}
