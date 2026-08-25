import express from "express";
import FacestockStock from "../../models/inventory/facestockStock.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";

const router = express.Router();

// Flat, per-reel listing of raw material that's live right now -- a reel
// that's been scanned and Start-punched on a still-open job
// (PendingProduction.liveMaterialInUse), no Kg yet since that isn't
// reported until Save Production Entry. Not facestock-only -- every raw-
// material pool a job card can report usage against (see POOL_MODELS in
// utils/labelStockProduction.js), each with its own Stock model. `item` is
// the column the WIP Stock page filters on to pick one pool out of the
// three, or leaves blank for all. Deliberately excludes reels already fully
// drawn off via a job card's Material Used dialog -- this page is only for
// what's in use right now, not a usage history.
const USAGE_POOL_CONFIG = {
  facestock: { item: "Facestock", Model: FacestockStock, specFields: "rollId type make vendorName vendorSkuCode location" },
  adhesive: { item: "Adhesive", Model: AdhesiveStock, specFields: "rollId type make vendorName vendorSkuCode location" },
  release: { item: "Release Liner", Model: ReleaseLinerStock, specFields: "rollId type make vendorName vendorSkuCode location" },
};

async function loadWipRows() {
  const liveExistsOr = Object.keys(USAGE_POOL_CONFIG).map((pool) => ({ [`liveMaterialInUse.${pool}.0`]: { $exists: true } }));
  const pending = await PendingProduction.find({ producedAt: null, $or: liveExistsOr })
    .select("lotNo itemId liveMaterialInUse updatedAt")
    .populate({ path: "itemId", select: "productCode" })
    .lean();

  const rows = [];
  for (const [pool, cfg] of Object.entries(USAGE_POOL_CONFIG)) {
    const stockIds = new Set();
    pending.forEach((p) => (p.liveMaterialInUse?.[pool] || []).forEach((id) => stockIds.add(String(id))));
    if (!stockIds.size) continue;

    const reels = await cfg.Model.find({ _id: { $in: [...stockIds] } }).select(cfg.specFields).lean();
    const reelById = new Map(reels.map((r) => [String(r._id), r]));

    for (const p of pending) {
      for (const id of p.liveMaterialInUse?.[pool] || []) {
        const reel = reelById.get(String(id));
        rows.push({
          item: cfg.item,
          rollId: reel?.rollId || "",
          type: reel?.type || "",
          make: reel?.make || "",
          vendorName: reel?.vendorName || "",
          vendorSkuCode: reel?.vendorSkuCode || "",
          location: reel?.location || "",
          lotNo: p.lotNo || "",
          productCode: p.itemId?.productCode || "",
          date: p.updatedAt || null,
        });
      }
    }
  }

  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return rows;
}

// Flat "which stock is being used right now, and for which job" listing --
// the same LIVE signal each reel's dropdown badge on the Facestock/
// Adhesive/Release Liner Stock pages already carries, just laid out one
// row per reel-in-use instead of needing every master's dropdown opened to
// find it. See loadWipRows.
router.get("/", async (req, res) => {
  const rows = await loadWipRows();
  res.render("stock/wipStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "WIP Stock",
    rows,
    notification: req.flash("notification"),
  });
});

export default router;
