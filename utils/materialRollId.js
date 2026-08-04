import Counter from "../models/system/counter.js";

// ---------------------------------------------------------------------------
// Roll ID generation for the raw-material stock pools (Facestock/Adhesive/
// Release Liner stock -- see models/inventory/facestockStock.js etc.).
// Separate from utils/rollId.js, which is wired to MaterialStock's own
// finished-label-stock reels and its production-consumption pipeline; these
// pools don't feed that pipeline and have no per-item product code to key
// off, so the sequence is scoped by a fixed category prefix + financial year
// instead (e.g. FACESTOCK/26-27/001), rather than per spec/type.
// ---------------------------------------------------------------------------

// Indian financial year, April-March. Evaluated at generation time -- a reel
// inwarded on the last day of March and one inwarded the next day get
// different years, same as the paperwork would.
export function financialYearLabel(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1; // getMonth() 3 = April
  const two = (y) => String(y).slice(-2);
  return `${two(startYear)}-${two(startYear + 1)}`;
}

const counterKey = (prefix, fy) => `materialRollId:${prefix}:${fy}`;

export const formatMaterialRollId = (prefix, fy, seq) => `${prefix}/${fy}/${String(seq).padStart(3, "0")}`;

// Claims the next sequence number for this prefix's current financial year.
// A generated id is checked against the target model before it is handed
// out, so a pre-existing manually-assigned id can never collide.
export async function generateMaterialRollId(prefix, Model) {
  const fy = financialYearLabel();
  const key = counterKey(prefix, fy);

  for (let attempt = 0; attempt < 10000; attempt++) {
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = formatMaterialRollId(prefix, fy, counter.seq);
    if (!(await Model.exists({ rollId: candidate }))) return candidate;
  }
  throw new Error("Unable to generate a unique roll id");
}

// What the next `count` reels for this prefix would be called, without
// consuming any sequence numbers -- the batch inward dialog shows these in
// the (read-only) Roll ID field of each roll row as soon as the row count
// changes. Not reserved, so two dialogs open at once can preview the same
// ids; only generateMaterialRollId() above actually claims one.
export async function previewMaterialRollIds(prefix, count = 1) {
  const fy = financialYearLabel();
  const key = counterKey(prefix, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const start = Number(counter?.seq || 0) + 1;
  return Array.from({ length: count }, (_, i) => formatMaterialRollId(prefix, fy, start + i));
}

// What the next reel for this prefix would be called -- single-id form of
// previewMaterialRollIds(), for callers that only ever add one reel at a time.
export async function previewMaterialRollId(prefix) {
  const [id] = await previewMaterialRollIds(prefix, 1);
  return id;
}
