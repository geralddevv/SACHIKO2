import Counter from "../models/system/counter.js";
import FinishedStock from "../models/inventory/finishedStock.js";
import { financialYearLabel, formatRollId } from "./rollId.js";

const normalizeItemCode = (value) => String(value ?? "").trim().toUpperCase();

// ---------------------------------------------------------------------------
// Finished roll identity. Mirrors utils/rollId.js (Deckle ids) exactly, but
// scoped to Finished Stock (models/inventory/finishedStock.js) with its own
// counter namespace -- a Deckle and the finished rolls slit off it share the
// same product code, so the two sequences must not share a counter key or
// they'd collide/interleave.
//
// Format: ITEMCODE/YY-YY/NNN, same as Deckle ids -- see utils/rollId.js for
// the rationale.
// ---------------------------------------------------------------------------

const rollCounterKey = (itemCode, fy) => `finishedRollId:${itemCode}:${fy}`;

// Claims the next sequence number for this item code's current financial
// year. A generated id is checked against stock before it is handed out, so
// a pre-existing manually-assigned id can never collide.
export async function generateFinishedRollId(itemCodeRaw) {
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
    if (!(await FinishedStock.exists({ rollId: candidate }))) return candidate;
  }
  throw new Error("Unable to generate a unique roll id");
}

// What the next roll for this item code would be called, without consuming a
// sequence number -- shown read-only as soon as the item is known.
export async function previewFinishedRollId(itemCodeRaw) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  if (!itemCode) return "";

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  return formatRollId(itemCode, fy, Number(counter?.seq || 0) + 1);
}

// Same idea as previewFinishedRollId, but for a whole slitting batch (one
// Deckle can be slit into several rolls at once) -- returns the next `count`
// ids in sequence, still without consuming anything.
export async function previewFinishedRollIds(itemCodeRaw, count) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!itemCode || !n) return [];

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const start = Number(counter?.seq || 0) + 1;
  return Array.from({ length: n }, (_, i) => formatRollId(itemCode, fy, start + i));
}
