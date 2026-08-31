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
// scannable and searchable. Built from its parts because extractScannedRollId
// below needs the two tails on their own as well -- a printed label's QR ends
// with the Roll ID rather than being one, so the id has to be found by its
// tail. An item code may carry hyphens inside it but never leads or ends with
// one (nothing that mints one produces that, and allowing it would let the
// dashed-out empty boxes on a label be read as part of an id).
const FY = "\\d{2}-\\d{2}";
const SEQ_TAIL = `\\/${FY}\\/\\d{3,}`;                       // .../26-27/007
const DECKLE_TAIL = `\\/${FY}\\/[A-Z]+\\d{4,}\\/\\d{5,}`;   // .../26-27/G0004/00001
const ITEM_CODE = "[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?";

export const ROLL_ID_RE = new RegExp(`^(?:${ITEM_CODE}${SEQ_TAIL}|${ITEM_CODE}${DECKLE_TAIL})$`);

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

// ---------------------------------------------------------------------------
// Reading a Roll ID back off a scan.
//
// A scan does NOT arrive as a Roll ID. There are two QR payload formats, and
// the Roll ID sits in a different place in each:
//
//  1. utils/rollLabel.js -- "rollId vendorRollId paperSize reelMtrs", space
//     separated, Roll ID FIRST. The on-screen preview label.
//
//  2. utils/materialRollLabel.js (buildQrPayloadFromFields) -- the payload on
//     the *printed* sticker a reel gets when its stock is created at inward,
//     and the one a phone or a hand scanner on the shop floor actually meets.
//     It runs twelve fields together with NO separator at all, in the sample
//     label's own order, and the Roll ID is the LAST of them:
//
//       clientName prodCode mfgDate face joints lotNo
//       adhesive release length weight width rollId
//
//     A facestock reel therefore scans as
//       "AVERY DENNISONAD-710013-8-2026--INV/2026/1123---250KG1000FACESTOCK/26-27/007"
//     and a produced Deckle as
//       "-C00113-8-2026-2LOT-0004--1200MTR-1000C001/26-27/G0004/00001"
//
// This used to take the first whitespace-separated token, which reads "AVERY"
// off that first label -- format 2 has to be read from the END instead.
//
// Reading it from the end is exact down to one point: the field before the
// Roll ID (`width`, e.g. "1000") is glued straight onto the item code with
// nothing between them, and every character of both is legal in an item code.
// The rules below settle that with evidence rather than a guess, and where
// they have none they keep the whole run -- an id that reads back as "unknown
// reel" is recoverable, one silently shortened into a DIFFERENT reel's id is
// not. findScannedReel() removes the guesswork entirely where a Model is at
// hand: it asks the database which candidate actually exists.
//
// Must stay in step with the client copy in
// views/inventory/masters/jobCardForm.ejs and with the operator app's own
// src/utils/rollId.js.
// ---------------------------------------------------------------------------

// A Roll ID's tail where format 2 puts it: at the very end of the payload.
const TRAILING_TAIL_RE = new RegExp(`(?:${DECKLE_TAIL}|${SEQ_TAIL})$`);
// Everything item-code-legal immediately before that tail. This deliberately
// over-reaches (it runs back through `width` and, on a Deckle label, through
// most of the payload) -- narrowing it down is the job of the rules below.
const CODE_RUN_RE = /[A-Z0-9-]+$/;
// The fixed item codes utils/materialRollId.js mints for the raw-material
// pools (each of routes/stock/{facestock,adhesive,releaseLiner,core}Stock.js's
// own ROLL_ID_PREFIX). For those the item code is a known constant, so there
// is nothing to infer.
const POOL_PREFIX_RE = /(FACESTOCK|ADHESIVE|RELEASE|CORE)$/;
// Where a Deckle label's PROD CODE box lands in the compacted payload. It is
// field 2, and field 1 (CLIENT NAME) is hardcoded "-" on that label -- see
// utils/materialStockRollLabel.js's buildLabelFields -- so a corroborating
// product code always starts at index 1. Bounding it there is what stops a
// stray one-character coincidence deeper in the payload passing as evidence.
const PROD_CODE_START = 1;

// Every Roll ID this scan could be, best first. Used on its own by
// extractScannedRollId (take the first) and by findScannedReel (ask the
// database which one exists).
export function scannedRollIdCandidates(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const out = [];
  const push = (id) => {
    if (id && ROLL_ID_RE.test(id) && !out.includes(id)) out.push(id);
  };

  const first = normalizeRollId(raw.split(/\s+/)[0]);
  const compact = normalizeRollId(raw);

  // Format 1: Roll ID first, then vendorRollId/paperSize/reelMtrs. Taken
  // before whitespace is squeezed out, because collapsing
  // "C011/26-27/048 12345" first would run the trailing vendor roll number
  // into the sequence and read it back as ".../04812345".
  //
  // Only when the entry really is several tokens, though. A format-2 payload
  // has no separators at all, and its own run-together text can itself
  // satisfy the (deliberately permissive) Roll ID grammar -- an item code may
  // hold digits and hyphens, so "UPM-13-8-2026------90KG-FACESTOCK/26-27/113"
  // parses as one -- which would hand back the whole sticker as an id. A
  // single token goes to the structural read below, which gives the same
  // answer for a genuinely bare id and the right one for a payload.
  if (compact !== first) push(first);

  const tail = TRAILING_TAIL_RE.exec(compact);
  if (!tail) return out;
  const before = compact.slice(0, tail.index);
  const run = CODE_RUN_RE.exec(before);
  if (!run) return out;

  // A raw-material reel: the run ends in one of the four minted prefixes, and
  // that prefix IS the item code. Exact.
  const pool = POOL_PREFIX_RE.exec(run[0]);
  if (pool) push(pool[1] + tail[0]);

  // A Deckle: the label names its own item code twice, because the PROD CODE
  // box holds exactly the code the Roll ID is built from. So the longest
  // suffix of the run that also opens the payload at PROD_CODE_START is the
  // item code -- "C001" is corroborated there, while "1000C001", "000C001",
  // ... (the same run with more of `width` still stuck to it) are not. The
  // occurrence must be strictly before the candidate's own position, so the
  // run can never corroborate itself.
  for (let i = 0; i < run[0].length; i++) {
    const candidate = run[0].slice(i);
    const at = compact.indexOf(candidate);
    if (candidate[0] !== "-" && at === PROD_CODE_START && at < run.index + i) {
      push(candidate + tail[0]);
      break;
    }
  }

  // Nothing corroborated: every remaining way the run could split, longest
  // item code first. The first of these is the whole run, which is what
  // extractScannedRollId falls back to -- it would rather hand the server an
  // id that does not exist than one that exists and is the wrong reel. The
  // shorter splits are there for findScannedReel, which can tell them apart
  // by asking the database.
  for (let i = 0; i < run[0].length; i++) {
    if (run[0][i] !== "-") push(run[0].slice(i) + tail[0]);
  }
  return out;
}

// The single best reading of a scan (or of a typed/stored id, which passes
// through unchanged bar normalisation).
//
// `knownRollIds` is optional: pass the Roll IDs already known to belong to the
// pool being scanned into and an exact match against those is preferred to any
// parsing -- a format-2 payload ENDS with the reel's Roll ID, a format-1 one
// STARTS with it, and a typed one is it. The web form and the operator app
// both have that list; server-side callers with a Model in hand should use
// findScannedReel below instead, which is exact for every reel in the pool.
export function extractScannedRollId(value, knownRollIds) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const first = normalizeRollId(raw.split(/\s+/)[0]);

  if (Array.isArray(knownRollIds) && knownRollIds.length) {
    const compact = normalizeRollId(raw);
    const known = knownRollIds
      .map(normalizeRollId)
      .filter((id) => id && (compact === id || compact.endsWith(id) || compact.startsWith(id)))
      .sort((a, b) => b.length - a.length)[0];
    if (known) return known;
  }

  // The best-ranked reading, or -- when there is nothing roll-ID-shaped in
  // there at all -- the old first-token rule, so an id in some format this
  // file doesn't know still reaches its lookup to be judged there rather than
  // being swallowed here.
  return scannedRollIdCandidates(raw)[0] || first;
}

// The reel a scan actually names, resolved against the pool it was scanned
// into. This is the exact answer where extractScannedRollId can only be a best
// reading: the ambiguity is always which prefix of the item code belongs to
// the `width` box in front of it, and only stock itself can say. Candidates
// are looked up in one indexed query and the best-ranked one that exists wins,
// so a product code that happens to contain a shorter one can't shadow it.
export async function findScannedReel(Model, value, select) {
  const candidates = scannedRollIdCandidates(value);
  if (!candidates.length) return null;

  let query = Model.find({ rollId: { $in: candidates } });
  if (select) query = query.select(select);
  const docs = await query.lean();
  if (!docs.length) return null;

  const byRollId = new Map(docs.map((doc) => [normalizeRollId(doc.rollId), doc]));
  for (const candidate of candidates) {
    const doc = byRollId.get(candidate);
    if (doc) return doc;
  }
  return null;
}

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
