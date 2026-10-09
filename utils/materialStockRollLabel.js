import {
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  fieldOrDash,
  sanitizeField,
  formatLabelDate,
  buildQrPayloadFromFields,
  buildPrnFromFields,
  labelLayoutMm,
  rollLabelQrDataUrl,
  rollLabelModuleCount,
  applyPrnTextPlan,
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
// while FACE/ADHESIVE/RELEASE print the recipe's layer GSM.
export { LABEL_WIDTH_MM, LABEL_HEIGHT_MM, applyPrnTextPlan, labelLayoutMm, rollLabelQrDataUrl, rollLabelModuleCount };

// "80", or "80/90" for a double-layer recipe (DOUBLE FACESTOCK / DOUBLE
// RELEASE carry a second facestock/adhesive/release layer) -- the bare number,
// the boxes are captioned on the pre-printed stock. A facestock specified in
// microns has no GSM, so its micron figure prints in the same place. "-" when
// there is no figure.
//
// Each layer is { reel, recipe }: `reel` is the GSM of the stock reel(s)
// actually allotted to the order (see utils/deckleLayerGsm.js) and wins; the
// recipe's own figure is only the fallback for a Deckle with no allotment.
const layerGsmText = (layers, micronKey) => {
  const gsm = layers.map(({ reel, recipe }) => (reel?.length ? reel.join("+") : sanitizeField(recipe?.gsm))).filter(Boolean);
  if (gsm.length) return gsm.join("/");
  const mic = micronKey ? layers.map(({ recipe }) => sanitizeField(recipe?.[micronKey])).filter(Boolean) : [];
  return mic.length ? mic.join("/") : "-";
};

// FACE / ADHESIVE / RELEASE text for a Deckle. `material` is its populated
// SachikoLabelStock recipe (select facestock, facestock2, adhesive, adhesive2,
// releaseLiner, releaseLiner2); `reelGsm` maps a layer key ("facestock",
// "adhesive2", ...) to the GSM values of the reels allotted to that layer.
export function deckleLayerGsm(material, reelGsm = {}) {
  const m = material || {};
  const layer = (key, gsmField) => ({ reel: reelGsm[key], recipe: { gsm: m[key]?.[gsmField], micron: m[key]?.facestockMicron } });
  return {
    faceGsm: layerGsmText([layer("facestock", "facestockGsm"), layer("facestock2", "facestockGsm")], "micron"),
    adhesiveGsm: layerGsmText([layer("adhesive", "adhesiveGsm"), layer("adhesive2", "adhesiveGsm")]),
    releaseGsm: layerGsmText([layer("releaseLiner", "releaseLinerGsm"), layer("releaseLiner2", "releaseLinerGsm")]),
  };
}

export function buildLabelFields({ prodCode, reelMtrs, rollId, printedOn, size, joints, lotNo, faceGsm, adhesiveGsm, releaseGsm }) {
  const length = fieldOrDash(reelMtrs);
  return {
    clientName: "-",                    // CLIENT NAME box <- no vendor/client on a produced Deckle
    prodCode: fieldOrDash(prodCode),    // PROD CODE box   <- its SachikoLabelStock recipe's own code
    mfgDate: formatLabelDate(printedOn),
    lotNo: fieldOrDash(lotNo),           // LOT NO box      <- the Deckle's production lot
    // These three SOFT.prn boxes describe the raw layers: each prints its
    // layer's GSM (see deckleLayerGsm). The QR payload deliberately does NOT
    // carry them -- see buildQrPayload.
    face: fieldOrDash(faceGsm),
    adhesive: fieldOrDash(adhesiveGsm),
    release: fieldOrDash(releaseGsm),
    joints: sanitizeField(joints) || "0", // JOINTS box <- status captured on the production-log row; "0" (not "-") when the run had none
    length,                              // LENGTH box <- reelMtrs, bare: the box is captioned "LENGTH" on the pre-printed stock, so the unit was saying it twice
    weight: "-",                        // WEIGHT box      <- not tracked for a Deckle
    width: fieldOrDash(size),            // WIDTH box       <- Deckle's finished size
    rollId: fieldOrDash(rollId),
  };
}

// The QR keeps the three layer boxes as "-": the operator app reads a scanned
// Deckle payload from its tail (src/utils/rollId.js) and Deckle stickers
// already in circulation scan with "-" there, so adding the GSM text would
// change what every scanner has to parse for no gain -- the GSM is read off
// the printed boxes, not the code. Likewise a blank JOINTS stays "-" here even
// though the box prints "0".
export function buildQrPayload(reel) {
  return buildQrPayloadFromFields(buildLabelFields({ ...reel, faceGsm: undefined, adhesiveGsm: undefined, releaseGsm: undefined, joints: fieldOrDash(reel.joints) }));
}

// Not what the Print button uses (that goes through the browser's own print
// dialog -- see views/stock/materialStockRollLabel.ejs), but kept as the
// reference the on-screen label is measured against, and the way to drive a
// TSC unit directly if the browser path is ever swapped for raw printing.
export function buildMaterialStockRollLabelPrn(reel) {
  return buildPrnFromFields(buildLabelFields(reel), { qrPayload: buildQrPayload(reel) });
}
