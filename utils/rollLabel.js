import QRCode from "qrcode";

// On-screen QR preview for a facestock reel's Roll ID label. Ported from
// FAIRTECH's utils/rollLabel.js -- adapted to be self-contained since Sachiko
// has no thermal-printer .prn pipeline yet (FAIRTECH's utils/rollLabelPrn.js
// is not ported; the on-screen QR alone is enough to exercise scan-and-deduct
// from a phone/laptop camera).

export const QR_ECC_LEVEL = "L";

// TSPL/print concerns aside, the QR payload itself still needs to be quote-
// and whitespace-safe: rollId is system-generated and never carries stray
// characters; vendorRollId is operator-typed, so it's stripped defensively.
const sanitizeField = (value) => String(value ?? "").replace(/"/g, "");

// Must stay in step with extractScannedRollId in utils/rollId.js and the
// client copy in views/inventory/masters/jobCardForm.ejs -- the Roll ID is
// always the first whitespace-separated token.
export function buildQrPayload({ rollId, vendorRollId, paperSize, reelMtrs }) {
  return [
    sanitizeField(rollId),
    sanitizeField(vendorRollId),
    sanitizeField(paperSize),
    sanitizeField(reelMtrs),
  ].join(" ");
}

// Rendered as a raster PNG data URL, not SVG -- see FAIRTECH's utils/rollLabel.js
// for why (an SVG-based QR here went through two rendering bugs before it was
// ever fully reliable; a raster bitmap scales uniformly everywhere).
export async function rollLabelDataUrl(content) {
  return QRCode.toDataURL(String(content ?? ""), {
    errorCorrectionLevel: QR_ECC_LEVEL,
    margin: 1,
    width: 600,
  });
}

// Module count (the QR's own grid size) for the same content/ECC level
// rollLabelDataUrl renders -- lets a caller size a preview box to match.
export function rollLabelModuleCount(content) {
  return QRCode.create(String(content ?? ""), { errorCorrectionLevel: QR_ECC_LEVEL }).modules.size;
}
