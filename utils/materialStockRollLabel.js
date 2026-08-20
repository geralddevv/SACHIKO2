import {
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  fieldOrDash,
  formatLabelDate,
  buildQrPayloadFromFields,
  buildPrnFromFields,
  labelLayoutMm,
  rollLabelQrDataUrl,
  rollLabelModuleCount,
} from "./materialRollLabel.js";

// The label a produced Deckle (finished, laminated Label Stock -- see
// models/inventory/materialStock.js) gets stuck on it, so the reel can be
// identified on the shop floor. The shared pre-printed geometry lives in
// utils/materialRollLabel.js -- this file only says which of MaterialStock's
// (+ its populated SachikoLabelStock recipe's) own fields go in which box;
// see utils/facestockRollLabel.js for the sibling this was modeled on.
//
// Unlike a raw-material reel, a Deckle IS the finished label stock these
// boxes were designed for: FACE/ADHESIVE/RELEASE come straight from its
// SachikoLabelStock recipe, and reelMtrs is metres of finished stock (not
// kilos, unlike the raw-material pools), so it fills LENGTH rather than
// WEIGHT. A Deckle has no vendor/client and isn't invoiced, so CLIENT NAME,
// LOT NO and WEIGHT print "-".
export { LABEL_WIDTH_MM, LABEL_HEIGHT_MM, labelLayoutMm, rollLabelQrDataUrl, rollLabelModuleCount };

export function buildLabelFields({ prodCode, reelMtrs, rollId, printedOn, face, adhesive, release }) {
  const length = fieldOrDash(reelMtrs);
  return {
    clientName: "-",                    // CLIENT NAME box <- no vendor/client on a produced Deckle
    prodCode: fieldOrDash(prodCode),    // PROD CODE box   <- its SachikoLabelStock recipe's own code
    mfgDate: formatLabelDate(printedOn),
    lotNo: "-",                         // LOT NO box      <- not invoiced, it's produced in-house
    face: fieldOrDash(face),
    adhesive: fieldOrDash(adhesive),
    release: fieldOrDash(release),
    joints: "-",                        // JOINTS box      <- splice count isn't tracked
    length: length === "-" ? "-" : `${length}MTR`, // LENGTH box <- reelMtrs is metres in this pool
    weight: "-",                        // WEIGHT box      <- not tracked for a Deckle
    width: "-",                         // WIDTH box       <- not on MaterialStock's schema
    rollId: fieldOrDash(rollId),
  };
}

export function buildQrPayload(reel) {
  return buildQrPayloadFromFields(buildLabelFields(reel));
}

// Not what the Print button uses (that goes through the browser's own print
// dialog -- see views/stock/materialStockRollLabel.ejs), but kept as the
// reference the on-screen label is measured against, and the way to drive a
// TSC unit directly if the browser path is ever swapped for raw printing.
export function buildMaterialStockRollLabelPrn(reel) {
  return buildPrnFromFields(buildLabelFields(reel));
}
