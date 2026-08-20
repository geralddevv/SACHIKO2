import {
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  sanitizeField,
  fieldOrDash,
  formatLabelDate,
  buildQrPayloadFromFields,
  buildPrnFromFields,
  labelLayoutMm,
  rollLabelQrDataUrl,
  rollLabelModuleCount,
} from "./materialRollLabel.js";

// The label an inwarded Release Liner reel gets stuck on it, so the next step
// (Label Stock Production) can identify the roll. The shared pre-printed
// geometry (which box a value lands in, the mm layout, the QR/PRN builders)
// lives in utils/materialRollLabel.js -- this file only says which of
// Release Liner Stock's own fields go in which box; see
// utils/facestockRollLabel.js for the sibling this was modeled on.
export { LABEL_WIDTH_MM, LABEL_HEIGHT_MM, labelLayoutMm, rollLabelQrDataUrl, rollLabelModuleCount };

// The reel's values in the pre-printed grid's own slots. FACE/ADHESIVE/
// RELEASE/JOINTS/LENGTH are captions inherited from the finished
// label-stock version of this sticker; a raw release liner reel carries no
// such figures, so they print "-" rather than leaving an empty box that
// looks like the printer skipped a line.
export function buildLabelFields({ vendorName, vendorSkuCode, invoiceNo, reelMtrs, size, rollId, printedOn }) {
  const weight = sanitizeField(reelMtrs);
  return {
    clientName: fieldOrDash(vendorName),  // CLIENT NAME box <- the reel's supplier
    prodCode: fieldOrDash(vendorSkuCode), // PROD CODE box   <- the vendor's own code for the spec
    mfgDate: formatLabelDate(printedOn),  // MFG DATE box    <- date the label is printed
    lotNo: fieldOrDash(invoiceNo),        // LOT NO box      <- the purchase invoice this reel came in on
    face: "-",
    adhesive: "-",
    release: "-",
    joints: "-",
    length: "-",
    weight: weight ? `${weight}KG` : "-", // WEIGHT box      <- reelMtrs is kilos in this pool
    width: fieldOrDash(size),             // WIDTH box       <- the spec's size (mm)
    rollId: fieldOrDash(rollId),
  };
}

export function buildQrPayload(reel) {
  return buildQrPayloadFromFields(buildLabelFields(reel));
}

// Not what the Print button uses (that goes through the browser's own print
// dialog -- see views/stock/releaseLinerRollLabel.ejs), but kept as the
// reference the on-screen label is measured against, and the way to drive a
// TSC unit directly if the browser path is ever swapped for raw printing.
export function buildReleaseLinerRollLabelPrn(reel) {
  return buildPrnFromFields(buildLabelFields(reel));
}
