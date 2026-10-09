import FacestockStock from "../models/inventory/facestockStock.js";
import AdhesiveStock from "../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import { pickStockIds } from "./labelStockProduction.js";
import { deckleLayerGsm } from "./materialStockRollLabel.js";

// Where a Deckle label's FACE / ADHESIVE / RELEASE GSM comes from: the stock
// reels (and adhesive drums) allotted to the order the Deckle was made for
// (PendingProduction.allottedLayers), each of which carries the GSM copied
// from its Master at inward -- not the SachikoLabelStock recipe, which is only
// the fallback for a Deckle with no allotment (or a reel with no GSM).
const LAYER_POOL = {
  facestock: FacestockStock,
  facestock2: FacestockStock,
  adhesive: AdhesiveStock,
  adhesive2: AdhesiveStock,
  releaseLiner: ReleaseLinerStock,
  releaseLiner2: ReleaseLinerStock,
};

export async function resolveDeckleLayerGsm(material, producedFor) {
  const reelGsm = {};
  const pendingId = producedFor?._id || producedFor;
  if (pendingId) {
    const order = await PendingProduction.findById(pendingId).select("allottedLayers").lean();
    for (const [key, Model] of Object.entries(LAYER_POOL)) {
      const ids = pickStockIds(order?.allottedLayers?.[key]);
      if (!ids.length) continue;
      const reels = await Model.find({ _id: { $in: ids } }).select("gsm").lean();
      const values = [...new Set(reels.map((r) => r.gsm).filter((g) => g != null))];
      if (values.length) reelGsm[key] = values;
    }
  }
  return deckleLayerGsm(material, reelGsm);
}
