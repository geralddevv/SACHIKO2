import QRCode from "qrcode";

// The physical sticker every raw-material inward reel/drum gets stuck on --
// Facestock, Adhesive and Release Liner Stock all inward onto the SAME
// pre-printed label stock (SOFT.prn, repo root), just filling different
// subsets of its boxes. This module is the one place that pre-printed
// geometry lives; utils/facestockRollLabel.js, utils/adhesiveRollLabel.js and
// utils/releaseLinerRollLabel.js each only supply their own field mapping
// (buildLabelFields) on top of it.
//
// The geometry comes from the shopfloor's known-working SOFT.prn. The label
// stock is PRE-PRINTED: the boxes and their captions ("CLIENT NAME",
// "PROD CODE", "WIDTH", ...) are already on the blank. So a coordinate here
// is not a layout choice -- it is which pre-printed box a value lands in. Do
// not "tidy" them.
//
// The .prn prints everything rotated 180 (the label is read by turning it
// around), so a TSPL coordinate is that element's rendered BOTTOM-RIGHT
// corner in printer space. Laid out as a human reads it -- printer (x,y)
// appears at (812-x, 601-y) -- the pre-printed grid is:
//
//   CLIENT NAME
//   PROD CODE
//   MFG DATE     | LOT NO
//   FACE         | ADHESIVE | RELEASE
//   JOINTS       | LENGTH   | WEIGHT
//   WIDTH (35pt) | ROLL ID (28pt) | QR
//
// A raw-material reel (facestock/adhesive/release liner) carries no figures
// for boxes structurally outside its own schema (e.g. Facestock has no
// FACE/ADHESIVE/RELEASE/JOINTS/LENGTH; Adhesive has no WIDTH; ...) -- those
// print "-" rather than leaving an empty box that looks like the printer
// skipped a line. Each pool's own buildLabelFields() decides which boxes it
// can fill and dashes the rest.
export const LABEL_WIDTH_MM = 101.5;
export const LABEL_HEIGHT_MM = 75.1;

// 8 dots/mm (203 dpi) -- the label is 812 x 601 dots, the space SOFT.prn's
// own coordinates live in.
export const DOTS_PER_MM = 8;
export const LABEL_WIDTH_DOTS = Math.round(LABEL_WIDTH_MM * DOTS_PER_MM); // 812
export const LABEL_HEIGHT_DOTS = Math.round(LABEL_HEIGHT_MM * DOTS_PER_MM); // 601

// One row per pre-printed box. `pt` is the TSPL scalable-font ("0") size,
// which that command specifies in points -- which is why the two hero fields
// (width, rollId) dwarf the rest.
//
// THE single source of truth for where a value goes. Both outputs are
// generated from this table -- the .prn's TEXT commands (buildPrnFromFields
// below) and the browser-printed label (views/stock/*RollLabel.ejs,
// positioned via labelLayoutMm below) -- so the two can never drift apart.
export const LABEL_SLOTS = {
  clientName: { x: 593, y: 487, pt: 10 },
  prodCode: { x: 593, y: 430, pt: 10 },
  mfgDate: { x: 593, y: 371, pt: 10 },
  lotNo: { x: 257, y: 371, pt: 10 },
  adhesive: { x: 394, y: 309, pt: 10 },
  face: { x: 657, y: 313, pt: 10 },
  joints: { x: 657, y: 256, pt: 10 },
  width: { x: 766, y: 138, pt: 35 },
  weight: { x: 143, y: 256, pt: 10 },
  release: { x: 146, y: 314, pt: 10 },
  rollId: { x: 538, y: 126, pt: 28 },
  length: { x: 394, y: 255, pt: 10 },
};

// SOFT.prn's own TEXT command order. Kept as its own list (rather than
// reusing LABEL_SLOTS' key order) only so generated output still diffs
// against SOFT.prn showing changed VALUES and nothing else. It is not a
// reading order and nothing but the .prn should use it.
const PRN_EMIT_ORDER = [
  "clientName", "prodCode", "mfgDate", "lotNo", "adhesive", "face",
  "joints", "width", "weight", "release", "rollId", "length",
];

// The QR runs every printed value together with no separator. This order is
// the sample label's own and is NOT the emit order above, so it is spelled
// out rather than derived from one.
const QR_ORDER = [
  "clientName", "prodCode", "mfgDate", "face", "joints", "lotNo",
  "adhesive", "release", "length", "weight", "width", "rollId",
];

export const QR_ANCHOR = { x: 147, y: 137 };
export const QR_CELL_WIDTH_DOTS = 3;
export const QR_ECC_LEVEL = "L";

// TSPL strings are double-quote delimited and the job is CRLF-framed line by
// line -- a stray quote or newline in any field would corrupt the command
// stream. rollId is system-generated and never carries one; every other
// field (vendor name, vendor SKU code, invoice no, size) is operator-typed,
// so all of them are stripped rather than trusted.
export const sanitizeField = (value) => String(value ?? "").replace(/["\r\n]/g, "").trim();

// Blank prints as "-", the same way the fields a pool structurally doesn't
// have do, so a missing value reads as "nothing here" instead of an empty
// pre-printed box that looks like the printer skipped it.
export const fieldOrDash = (value) => sanitizeField(value) || "-";

// "13-8-2026" -- D-M-YYYY, unpadded, exactly the sample label's format (not
// toLocaleDateString, whose output depends on the server's locale).
export function formatLabelDate(date = new Date()) {
  return `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;
}

// "01/09/26" -- dd/mm/yy, zero-padded. The format the current inward-label
// design (Sample inward design.svg) uses in its $DATE slot, shared by all
// three raw-material pools' buildInwardLabelFields(). Distinct from
// formatLabelDate above, which is the pre-printed SOFT.prn grid's own format.
export function formatShortLabelDate(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

// The QR payload for an already-built fields map (see each pool's own
// buildLabelFields).
export function buildQrPayloadFromFields(fields) {
  return QR_ORDER.map((key) => fields[key]).join("");
}

// The raw TSPL job -- byte-for-byte SOFT.prn with this fields map's values:
// same page setup, same xpml driver wrappers, same CRLF endings, same
// no-trailing-newline ending. Not what the Print button uses (that goes
// through the browser's own print dialog -- see views/stock/*RollLabel.ejs),
// but kept as the reference the on-screen label is measured against, and the
// way to drive a TSC unit directly if the browser path is ever swapped for
// raw printing.
export function buildPrnFromFields(fields) {
  const body = [
    `SIZE ${LABEL_WIDTH_MM} mm, ${LABEL_HEIGHT_MM} mm`,
    "GAP 3 mm, 0 mm",
    "SPEED 4",
    "DENSITY 10",
    "SET RIBBON ON",
    "DIRECTION 0,0",
    "REFERENCE 0,0",
    "OFFSET 0 mm",
    "SET PEEL OFF",
    "SET CUTTER OFF",
    "SET PARTIAL_CUTTER OFF",
  ].join("\r\n");

  const page = [
    "SET TEAR ON",
    "CLS",
    "CODEPAGE 1252",
    ...PRN_EMIT_ORDER.map((key) => {
      const { x, y, pt } = LABEL_SLOTS[key];
      return `TEXT ${x},${y},"0",180,${pt},${pt},"${fields[key]}"`;
    }),
    `QRCODE ${QR_ANCHOR.x},${QR_ANCHOR.y},${QR_ECC_LEVEL},${QR_CELL_WIDTH_DOTS},A,180,M2,S7,"${buildQrPayloadFromFields(fields)}"`,
    "PRINT 1,1",
  ].join("\r\n");

  // The xpml tags are the print driver's own page framing, kept verbatim
  // from SOFT.prn: a quantity='0' setup page (printer configuration, prints
  // nothing) followed by the quantity='1' page that actually draws. The file
  // ends immediately after </xpml> with no trailing newline.
  const pitch = `${LABEL_HEIGHT_MM} mm`;
  return (
    `<xpml><page quantity='0' pitch='${pitch}'></xpml>${body}\r\n`
    + `<xpml></page></xpml><xpml><page quantity='1' pitch='${pitch}'></xpml>${page}\r\n`
    + `<xpml></page></xpml><xpml><end/></xpml>`
  );
}

// The same layout in millimetres, for the browser-printed label.
//
// Two conversions in one: the .prn is rotated 180, so a slot's coordinate is
// its BOTTOM-RIGHT corner in printer space -- viewing the label the right
// way round maps that to the element's TOP-LEFT at
// (labelWidth - x, labelHeight - y). The HTML is therefore laid out the
// right way up with plain left/top offsets and no CSS rotation, and lands on
// the identical pre-printed boxes.
//
// `pt` passes straight through: TSPL's scalable font "0" sizes in points,
// which is CSS's own `pt` unit, so no conversion is needed or wanted.
// Two slots belong to the same printed row when their tops are within this
// many mm. Real rows sit ~7 mm apart while slots sharing a row differ by at
// most ~0.5 mm (the pre-printed captions aren't perfectly aligned), so the
// gap between those two scales is wide and this threshold is not delicate.
const SAME_ROW_TOLERANCE_MM = 4;

// Blank kept between one slot's text and the start of the next across the
// row, so a value shrunk to its limit still doesn't touch its neighbour.
const COLUMN_GUTTER_MM = 1;

export function labelLayoutMm(qrModuleCount) {
  const toMm = (dots) => Number((dots / DOTS_PER_MM).toFixed(3));
  const round = (v) => Number(v.toFixed(3));

  const qr = {
    left: toMm(LABEL_WIDTH_DOTS - QR_ANCHOR.x),
    top: toMm(LABEL_HEIGHT_DOTS - QR_ANCHOR.y),
    size: toMm(qrModuleCount * QR_CELL_WIDTH_DOTS),
  };

  const placed = Object.entries(LABEL_SLOTS).map(([key, { x, y, pt }]) => ({
    key,
    left: toMm(LABEL_WIDTH_DOTS - x),
    top: toMm(LABEL_HEIGHT_DOTS - y),
    pt,
  }));

  // How wide each value may grow before it runs into the next box across the
  // row, or off the label. Needed because the pre-printed boxes were sized
  // for the sample label's own values and ours are not the same length: a
  // Roll ID here is e.g. "FACESTOCK/26-27/007" (19 characters) where the
  // sample's was "#BAI 2216" (9), and at the design's 28pt that would be
  // about 137 mm of text on a 101.5 mm label. The label page measures
  // against this and shrinks the type until it fits, so a long value stays
  // inside its box instead of overprinting the next one or running off the
  // edge.
  //
  // The QR counts as an occupant of its row, which is what keeps the Roll ID
  // from growing underneath it.
  const occupants = [...placed, { key: "__qr", left: qr.left, top: qr.top }];
  const maxWidthFor = (slot) => {
    const nextLeft = occupants
      .filter((o) => o.key !== slot.key
        && Math.abs(o.top - slot.top) < SAME_ROW_TOLERANCE_MM
        && o.left > slot.left)
      .reduce((nearest, o) => Math.min(nearest, o.left), LABEL_WIDTH_MM + COLUMN_GUTTER_MM);
    return round(Math.max(nextLeft - COLUMN_GUTTER_MM - slot.left, 0));
  };

  return {
    labelWidth: LABEL_WIDTH_MM,
    labelHeight: LABEL_HEIGHT_MM,
    slots: Object.fromEntries(placed.map((s) => [
      s.key,
      { left: s.left, top: s.top, pt: s.pt, maxWidth: maxWidthFor(s) },
    ])),
    qr,
  };
}

// The QR as a raster PNG data URL, for the browser-printed label.
//
// margin: 0 is load-bearing, not a style choice. The qrcode package's
// default adds a 4-module quiet zone INSIDE the image, so the drawn code
// would be smaller than the box labelLayoutMm() sizes for it and offset up
// and left -- it would no longer sit in the pre-printed QR box. The
// surrounding label is white, so the quiet zone is there physically anyway.
//
// Raster rather than SVG deliberately: FAIRTECH's utils/rollLabel.js went
// through two rendering bugs with an SVG-based QR before it was reliable; a
// bitmap scales uniformly everywhere, including through a print driver.
export function rollLabelQrDataUrl(content) {
  return QRCode.toDataURL(String(content ?? ""), {
    errorCorrectionLevel: QR_ECC_LEVEL,
    margin: 0,
    width: 600,
  });
}

// The QR's own grid size for the same content and ECC level
// rollLabelQrDataUrl() renders -- what labelLayoutMm() multiplies by the
// cell width to size the box, so the printed code is the same physical size
// the thermal printer would lay down.
export function rollLabelModuleCount(content) {
  return QRCode.create(String(content ?? ""), { errorCorrectionLevel: QR_ECC_LEVEL }).modules.size;
}
