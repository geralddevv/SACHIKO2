import Counter from "../models/system/counter.js";
import MaterialStock from "../models/inventory/materialStock.js";

// ---------------------------------------------------------------------------
// Facestock reel identity. Ported from FAIRTECH's utils/rollId.js (paper
// reels there), adapted to Sachiko's facestock reels (MaterialStock).
//
// Every reel gets a Roll ID here, printed as a QR label and pasted on the
// physical roll. The job card's Roll ID field is filled by scanning that
// label, and the metres run against it are deducted from exactly that reel --
// so the id has to be unique.
//
// Format: ITEMCODE/YY-YY/NNN -- e.g. C011/26-27/048. ITEMCODE is the
// facestock's own product code (uppercased), YY-YY is the financial year the
// reel was inwarded in (April-March), and NNN is a sequence number scoped to
// that item+year (so it starts fresh each financial year rather than
// climbing forever, and a slow-moving item doesn't inherit a fast-moving
// one's high numbers).
// ---------------------------------------------------------------------------

// Accepts both pre-existing three-part roll IDs and the current five-part
// Deckle IDs, so stock already created before the format change remains
// scannable and searchable.
export const ROLL_ID_RE = /^(?:[A-Z0-9-]+\/\d{2}-\d{2}\/\d{3,}|[A-Z0-9-]+\/\d{2}-\d{2}\/[A-Z]+\d{4,}\/\d{5,})$/;

const normalizeItemCode = (value) => String(value ?? "").trim().toUpperCase();

// Indian financial year, April-March. Evaluated at generation time -- a reel
// inwarded on the last day of March and one inwarded the next day get
// different years, same as the paperwork would.
export function financialYearLabel(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1; // getMonth() 3 = April
  const two = (y) => String(y).slice(-2);
  return `${two(startYear)}-${two(startYear + 1)}`;
}

// Financial-year letter used in a Deckle ID. A = FY 2020-21, so FY 2026-27
// is G as specified: C001/26-27/G0001/00001. Continue alphabetically after
// Z (AA, AB, ...) rather than silently wrapping and risking duplicate IDs.
export function financialYearLetter(date = new Date()) {
  const startYear = date.getFullYear() - (date.getMonth() >= 3 ? 0 : 1);
  let n = startYear - 2020 + 1;
  let letters = "";
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return letters || "A";
}

// One counter per item code per financial year, so the sequence resets each
// year -- and starts fresh for each item -- instead of climbing forever
// shared across every material.
const rollCounterKey = (itemCode, fy) => `materialRollId:${itemCode}:${fy}`;

export const formatRollId = (itemCode, fy, seq) => `${itemCode}/${fy}/${String(seq).padStart(3, "0")}`;

// Scanners pad with stray whitespace and some are configured for lower case;
// the stored (and compared) form is upper case with no spaces.
export const normalizeRollId = (value) => String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();

// The QR on the label doesn't carry the Roll ID alone -- its payload is
// "rollId vendorRollId paperSize reelMtrs" (see utils/rollLabel.js), so a
// scan into a Roll ID box arrives as that whole space-separated string. The
// Roll ID is always the first token; this pulls just that out and normalizes
// it, so matching still works whether the box holds a full scan or someone
// typed/picked a bare roll id by hand. Must stay in step with the client copy
// in views/inventory/masters/jobCardForm.ejs.
export const extractScannedRollId = (value) => normalizeRollId(String(value ?? "").trim().split(/\s+/)[0] || "");

// Claims the next sequence number for this item code's current financial
// year. A generated id is checked against stock before it is handed out, so
// a pre-existing manually-assigned id can never collide.
export async function generateRollId(itemCodeRaw) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  if (!itemCode) throw new Error("A product code is required to generate a roll id");

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);

  for (let attempt = 0; attempt < 10000; attempt++) {
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = formatRollId(itemCode, fy, counter.seq);
    if (!(await MaterialStock.exists({ rollId: candidate }))) return candidate;
  }
  throw new Error("Unable to generate a unique roll id");
}

const deckleLotNumber = (lotNoRaw) => {
  const match = String(lotNoRaw ?? "").trim().match(/(\d+)$/);
  if (!match) throw new Error("A production lot number is required to generate a Deckle ID");
  return match[1].padStart(4, "0");
};

const deckleCounterKey = (itemCode, fy, yearLetter, lotNo) =>
  `deckleId:${itemCode}:${fy}:${yearLetter}:${lotNo}`;

// Deckle IDs are distinct from normal raw-material/finished roll IDs:
// PRODUCT/FY/<year-letter><lot-number>/<five-digit reel sequence>.
// Example for product C001, FY 2026-27 and lot 1:
// C001/26-27/G0001/00001.
export async function generateDeckleId(itemCodeRaw, lotNoRaw, date = new Date()) {
  const itemCode = normalizeItemCode(itemCodeRaw).replace(/\//g, "");
  if (!itemCode) throw new Error("A product code is required to generate a Deckle ID");

  const fy = financialYearLabel(date);
  const lotNo = deckleLotNumber(lotNoRaw);
  const yearLetter = financialYearLetter(date);
  const key = deckleCounterKey(itemCode, fy, yearLetter, lotNo);

  for (let attempt = 0; attempt < 10000; attempt++) {
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = `${itemCode}/${fy}/${yearLetter}${lotNo}/${String(counter.seq).padStart(5, "0")}`;
    if (!(await MaterialStock.exists({ rollId: candidate }))) return candidate;
  }
  throw new Error("Unable to generate a unique Deckle ID");
}

// What the next reel for this item code would be called, without consuming a
// sequence number -- the inward form shows it in the (read-only) Roll ID
// field as soon as the product code is picked. Empty item code (nothing
// picked yet) previews as "".
export async function previewRollId(itemCodeRaw) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  if (!itemCode) return "";

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  return formatRollId(itemCode, fy, Number(counter?.seq || 0) + 1);
}

// Same idea as previewRollId, but for a whole batch inward (one invoice can
// bring in several rolls of the same material at once) -- returns the next
// `count` ids in sequence, e.g. [.../013, .../014, .../015], still without
// consuming anything.
export async function previewRollIds(itemCodeRaw, count) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!itemCode || !n) return [];

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const start = Number(counter?.seq || 0) + 1;
  return Array.from({ length: n }, (_, i) => formatRollId(itemCode, fy, start + i));
}
