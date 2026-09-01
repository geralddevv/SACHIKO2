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
// A Deckle's reelMtrs is metres of finished stock (not kilos, unlike raw
// material), so it fills LENGTH rather than WEIGHT. Following SOFT.prn's
// requested mapping, WIDTH uses the Deckle size and JOINTS uses the status
// noted on its production-log row. A Deckle has no vendor/client or invoice,
// while FACE/ADHESIVE/RELEASE are deliberately kept "-".
export { LABEL_WIDTH_MM, LABEL_HEIGHT_MM, labelLayoutMm, rollLabelQrDataUrl, rollLabelModuleCount };

export function buildLabelFields({ prodCode, reelMtrs, rollId, printedOn, size, joints, lotNo }) {
  const length = fieldOrDash(reelMtrs);
  return {
    clientName: "-",                    // CLIENT NAME box <- no vendor/client on a produced Deckle
    prodCode: fieldOrDash(prodCode),    // PROD CODE box   <- its SachikoLabelStock recipe's own code
    mfgDate: formatLabelDate(printedOn),
    lotNo: fieldOrDash(lotNo),           // LOT NO box      <- the Deckle's production lot
    // These three SOFT.prn boxes describe raw layers; the Semi Finished
    // Deckle label intentionally keeps them blank as requested.
    face: "-",
    adhesive: "-",
    release: "-",
    joints: fieldOrDash(joints),         // JOINTS box <- status captured on the production-log row
    length,                              // LENGTH box <- reelMtrs, bare: the box is captioned "LENGTH" on the pre-printed stock, so the unit was saying it twice
    weight: "-",                        // WEIGHT box      <- not tracked for a Deckle
    width: fieldOrDash(size),            // WIDTH box       <- Deckle's finished size
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
