import PendingProduction from "../models/inventory/pendingProduction.js";
import { pickStockIds } from "./labelStockProduction.js";

// Takes one reel/drum out of every open order's allotment
// (PendingProduction.allottedLayers: { layerKey: { pool, stockIds: [...] } }, or
// the older single { pool, stockId }). Used when a stock reel is removed from
// stock while still allotted: the order keeps its other picks, and the layer
// that lost its reel simply has none again (the machine queue shows it short
// until it is re-picked in Assign Production). Returns the Lot Nos it touched.
export async function unallotReel(pool, stockId) {
  const id = String(stockId);
  const orders = await PendingProduction.find({ producedAt: null, allottedLayers: { $exists: true, $ne: null } })
    .select("allottedLayers lotNo")
    .lean();

  const released = [];
  for (const order of orders) {
    const next = {};
    let changed = false;
    for (const [key, pick] of Object.entries(order.allottedLayers || {})) {
      if (pick?.pool === pool && pickStockIds(pick).includes(id)) {
        changed = true;
        const left = pickStockIds(pick).filter((x) => x !== id);
        if (left.length) {
          const { stockId: _legacy, ...rest } = pick;
          next[key] = { ...rest, stockIds: left };
        }
      } else {
        next[key] = pick;
      }
    }
    if (!changed) continue;
    await PendingProduction.updateOne(
      { _id: order._id },
      Object.keys(next).length ? { $set: { allottedLayers: next } } : { $unset: { allottedLayers: "" } },
    );
    released.push(order.lotNo || String(order._id));
  }
  return released;
}
