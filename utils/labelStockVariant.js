import { createHash } from "crypto";
import Counter from "../models/system/counter.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";

// ---------------------------------------------------------------------------
// Label Stock Product Code variants ("C011" -> "C011-A", "C011-B", ...).
//
// Product Code is free text, not itself unique -- only the full
// labelStockSignature (every user-editable field, Product Code included) is
// unique-indexed, so nothing stops the *same* Product Code being entered (or,
// at production time, effectively re-derived from a substituted raw-material
// reel) against a genuinely different recipe.
//
// Two callers share this logic:
//   - routes/sachiko/sachiko_route.js's POST /label-stock/form (the manual
//     Label Stock create dialog) -- a Product Code re-entered against a
//     different recipe becomes a new variant; an EXACT re-entry is a mistake
//     to reject (onExactMatch: "throw", the default).
//   - produceDeckle() below (called from fairdesk_route.js's POST
//     /labels/production/assign/:id) -- Assign Production's raw-material
//     reel pickers only enforce POOL_MATCH_FIELDS (utils/
//     labelStockProduction.js), which deliberately leaves out Vendor/Size/
//     etc. (see that file's own comment), so the reel actually picked for a
//     layer can legitimately differ from the SKU's own stored spec in one of
//     those fields. When it does, the Deckle produced from it is materially
//     a different combination and gets tracked under its own "-A"/"-B"/...
//     variant instead of silently being counted as plain C011 stock -- and
//     an exact match there just means this substitution has already been
//     tracked (onExactMatch: "reuse").
// ---------------------------------------------------------------------------

function hashSignature(rawSignature) {
  return `sha256:${createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonStr(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function canonNum(value) {
  return value === undefined || value === null || value === "" ? "" : String(Number(value));
}

const FS_SIG_FIELDS = ["facestockFamily", "facestockType", "facestockMake", "facestockVendorId", "facestockVendorSkuCode", "facestockSize"];
const FS_SIG_NUM_FIELDS = ["facestockGsm", "facestockMicron"];
const AD_SIG_FIELDS = ["adhesiveType", "adhesiveMake", "adhesiveVendorId", "adhesiveVendorSkuCode"];
const AD_SIG_NUM_FIELDS = ["adhesiveGsm", "adhesiveViscosity", "adhesiveCohesion", "adhesiveShear", "adhesiveDensity"];
const RL_SIG_FIELDS = ["releaseLinerType", "releaseLinerMake", "releaseLinerSensing", "releaseLinerVendorId", "releaseLinerVendorSkuCode", "releaseLinerColor", "releaseLinerSize"];
const RL_SIG_NUM_FIELDS = ["releaseLinerGsm"];

function layerSignaturePart(layer, strFields, numFields) {
  if (!layer) return "";
  return strFields.map((f) => canonStr(layer[f])).concat(numFields.map((f) => canonNum(layer[f]))).join("|");
}

// Shared by buildLabelStockSignature/buildLabelStockSpecSignature -- every
// user-editable field buildLabelStockPayload (routes/sachiko/sachiko_route.js)
// sets, the top Product/Roll row plus all six facestock/adhesive/releaseLiner
// layers (2 and 2-suffixed ones included, blank/absent when the current
// rollType doesn't call for them), optionally including productCode.
function labelStockSignatureParts(payload, { includeProductCode }) {
  const parts = [];
  if (includeProductCode) parts.push(canonStr(payload.productCode));
  parts.push(
    canonStr(payload.rollType),
    canonStr(payload.family),
    canonStr(payload.rollOrSheet),
    canonStr(payload.printingTechnology),
    canonStr(payload.digitalPrintType),
    layerSignaturePart(payload.facestock, FS_SIG_FIELDS, FS_SIG_NUM_FIELDS),
    layerSignaturePart(payload.adhesive, AD_SIG_FIELDS, AD_SIG_NUM_FIELDS),
    layerSignaturePart(payload.releaseLiner, RL_SIG_FIELDS, RL_SIG_NUM_FIELDS),
    layerSignaturePart(payload.facestock2, FS_SIG_FIELDS, FS_SIG_NUM_FIELDS),
    layerSignaturePart(payload.adhesive2, AD_SIG_FIELDS, AD_SIG_NUM_FIELDS),
    layerSignaturePart(payload.releaseLiner2, RL_SIG_FIELDS, RL_SIG_NUM_FIELDS),
  );
  return parts.join("||");
}

// Hashes every user-editable field including Product Code -- so two rows
// only collide when they're the exact same record, not merely the same
// materials under a different Product Code.
export function buildLabelStockSignature(payload) {
  return hashSignature(labelStockSignatureParts(payload, { includeProductCode: true }));
}

// Same fields, minus Product Code -- used by resolveLabelStockProductCode
// below to tell whether a row sharing a Product Code (or "<code>-A"/"-B"/...
// of it) is genuinely the same material recipe or a different one that
// happens to share the code.
export function buildLabelStockSpecSignature(payload) {
  return hashSignature(labelStockSignatureParts(payload, { includeProductCode: false }));
}

// The six recipe layers, in labelStockSignatureParts order.
const RECIPE_LAYER_KEYS = ["facestock", "adhesive", "releaseLiner", "facestock2", "adhesive2", "releaseLiner2"];

const POOL_SIG_FIELDS = {
  facestock: [FS_SIG_FIELDS, FS_SIG_NUM_FIELDS],
  adhesive: [AD_SIG_FIELDS, AD_SIG_NUM_FIELDS],
  release: [RL_SIG_FIELDS, RL_SIG_NUM_FIELDS],
};

// "Is this the same layer spec?" key for ONE resolved layer -- the same
// canonicalization labelStockSignatureParts applies to it inside the full
// signature, so two different reels that resolve to a materially identical
// layer collapse to a single option (see resolveLabelStockCombinations).
function layerOptionKey(pool, layer) {
  const [strFields, numFields] = POOL_SIG_FIELDS[pool] || [[], []];
  return layerSignaturePart(layer, strFields, numFields);
}

// Every signature this file compares must be computed off the shape the row
// actually gets STORED as, not the shape it was assembled in -- the schema
// fills in defaults on save (releaseLiner/releaseLiner2's `releaseLinerColor:
// "WHITE"`, models/sachiko/sachikoLabelStock.js), so a payload hashed before
// that default lands would never match its own row when re-read later, and
// each production run would mint yet another "-B"/"-C" for the identical
// combination. Running both sides of every comparison (and the row about to
// be created) through the schema first removes that drift; it also levels
// legacy rows saved before a default existed against freshly-built payloads.
// Falls back to the raw object if the source can't be cast at all, so a
// single odd row can't break variant resolution outright.
function normalizeRecipe(source) {
  try {
    const obj = new SachikoLabelStock(source).toObject();
    delete obj._id;
    return obj;
  } catch {
    return { ...source };
  }
}

// A label stock's full recipe with only the named layers swapped out.
// Deliberately seeded from `labelStock`'s own six layers rather than built
// from the resolved ones alone: a layer nobody picked a reel for is produced
// to the SKU's own spec, so it has to compare equal to it -- and starting
// from the stored row is what guarantees that, field for field.
function rebuildRecipe(labelStock, layerOverrides = {}) {
  const recipe = {
    productCode: labelStock.productCode,
    rollType: labelStock.rollType,
    family: labelStock.family,
    rollOrSheet: labelStock.rollOrSheet,
    printingTechnology: labelStock.printingTechnology,
    digitalPrintType: labelStock.digitalPrintType,
  };
  for (const key of RECIPE_LAYER_KEYS) {
    recipe[key] = Object.prototype.hasOwnProperty.call(layerOverrides, key) ? layerOverrides[key] : labelStock[key];
  }
  return recipe;
}

// Material-only signature -- just the six facestock/adhesive/releaseLiner
// layers, none of the product-level fields (Product Code, Roll Type, Family,
// Roll/Sheet, Printing Technology) labelStockSignatureParts also hashes.
// Deliberately NOT unique-indexed on the model: unlike labelStockSignature
// (whose whole point is catching an exact duplicate row), two label stocks
// legitimately sharing this hash just means they're built from the same
// physical material stack under different Product Codes/classifications --
// a real, expected case, not a duplicate to reject.
//
// Also deliberately narrower than FS_SIG_FIELDS/AD_SIG_FIELDS/RL_SIG_FIELDS
// above: Size (Facestock/Release Liner) is left out, matching
// FS_ORDER/AD_ORDER/RL_ORDER in views/sachiko/labelStockView.ejs. Keep all
// three field lists in step if that ever changes.
const MAT_SIG_FS_FIELDS = ["facestockFamily", "facestockType", "facestockMake", "facestockVendorId", "facestockVendorSkuCode"];
const MAT_SIG_FS_NUM_FIELDS = ["facestockGsm", "facestockMicron"];
const MAT_SIG_AD_FIELDS = ["adhesiveType", "adhesiveMake", "adhesiveVendorId", "adhesiveVendorSkuCode"];
const MAT_SIG_AD_NUM_FIELDS = ["adhesiveViscosity", "adhesiveCohesion", "adhesiveShear", "adhesiveDensity"];
const MAT_SIG_RL_FIELDS = ["releaseLinerType", "releaseLinerMake", "releaseLinerSensing", "releaseLinerVendorId", "releaseLinerVendorSkuCode", "releaseLinerColor"];
const MAT_SIG_RL_NUM_FIELDS = ["releaseLinerGsm"];

// Consumed by another module (not this file) as a stable "same physical
// material stack" key -- keep its shape (sha256:<hex>, same as every other
// signature in this codebase) and field list stable once that module depends
// on it; re-run scripts/backfill-labelstock-material-signature.js after any
// change here to resync existing rows.
export function buildMaterialSignature(payload) {
  return hashSignature(
    [
      layerSignaturePart(payload.facestock, MAT_SIG_FS_FIELDS, MAT_SIG_FS_NUM_FIELDS),
      layerSignaturePart(payload.adhesive, MAT_SIG_AD_FIELDS, MAT_SIG_AD_NUM_FIELDS),
      layerSignaturePart(payload.releaseLiner, MAT_SIG_RL_FIELDS, MAT_SIG_RL_NUM_FIELDS),
      layerSignaturePart(payload.facestock2, MAT_SIG_FS_FIELDS, MAT_SIG_FS_NUM_FIELDS),
      layerSignaturePart(payload.adhesive2, MAT_SIG_AD_FIELDS, MAT_SIG_AD_NUM_FIELDS),
      layerSignaturePart(payload.releaseLiner2, MAT_SIG_RL_FIELDS, MAT_SIG_RL_NUM_FIELDS),
    ].join("||"),
  );
}

const escapeRegExpLS = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The family a Product Code belongs to: "C011-A" -> "C011", but only when a
// row actually named "C011" exists, so a code that genuinely ends in a single
// letter after a hyphen ("PET-A" entered as its own product) isn't mistaken
// for someone else's variant. Only single letters are stripped -- that's all
// resolveLabelStockProductCode ever mints.
async function variantFamilyRoot(productCode) {
  const match = /^(.*[^-])-[A-Z]$/.exec(String(productCode || ""));
  if (!match) return productCode;
  return (await SachikoLabelStock.exists({ productCode: match[1] })) ? match[1] : productCode;
}

// See the file-level comment above for the two callers/two onExactMatch
// behaviors. Groups every row already named `payload.productCode` or
// `<that code>-<LETTERS>` (its variant family) and compares recipes with
// buildLabelStockSpecSignature (Product Code itself excluded, since that's
// exactly the field this family shares):
//   - no family yet -> the code itself, unchanged.
//   - an existing family member has the identical recipe -> onExactMatch
//     decides: "throw" rejects with that row's Product Code; "reuse" returns
//     it.
//   - none match -> the next unused single-letter suffix (code-A, code-B,
//     ...).
//
// `familyRoot` is for the derived callers (production/allotment), where the
// SKU being produced can itself already BE a variant: without it, an order on
// "C011-A" would grow a second generation of suffixes ("C011-A-A") off its own
// name instead of joining the C011 family and taking the next free letter in
// it. The manual create dialog deliberately doesn't pass it -- a Product Code
// typed by hand is the base the user meant, suffix-looking or not.
export async function resolveLabelStockProductCode(payload, { onExactMatch = "throw", familyRoot = false } = {}) {
  const base = familyRoot ? await variantFamilyRoot(payload.productCode) : payload.productCode;
  const family = await SachikoLabelStock.find({
    productCode: new RegExp(`^${escapeRegExpLS(base)}(-[A-Z]+)?$`),
  }).lean();
  if (!family.length) return base;

  const specSignature = buildLabelStockSpecSignature(normalizeRecipe(payload));
  const suffixOf = (code) => (code === base ? "" : code.slice(base.length + 1));

  const exactMatch = family.find((doc) => buildLabelStockSpecSignature(normalizeRecipe(doc)) === specSignature);
  if (exactMatch) {
    if (onExactMatch === "reuse") return exactMatch.productCode;
    throw Object.assign(
      new Error("Duplicate Label Stock combination"),
      { userMessage: `This exact combination already exists as Product Code "${exactMatch.productCode}".` },
    );
  }

  const used = new Set(family.map((doc) => suffixOf(doc.productCode)).filter(Boolean));
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return `${base}-${letter}`;
  }
  throw Object.assign(
    new Error("Too many Label Stock variants"),
    { userMessage: `Too many variants of Product Code "${base}" already exist (max 26).` },
  );
}

// ---------------------------------------------------------------------------
// Product Code auto-numbering -- "<first letter of Family><NNN>", e.g. family
// CHROMO -> C001, C002, ...  The number is a running COUNT of the base codes
// already using that leading letter, plus one (not the highest number seen
// plus one) -- so deleting codes, or a stray high legacy code, doesn't push
// the next one far ahead of how many actually exist. One sequence per leading
// letter (two families that start with the same letter share it). Assigned
// server-side by routes/sachiko/sachiko_route.js's POST /label-stock/form; the
// create dialog shows this as a locked prefix and appends the user's typed
// suffix. The "-A"/"-B" variant suffixes (resolveLabelStockProductCode) still
// layer on top for production-time raw-material substitutions.
// ---------------------------------------------------------------------------
export function familyProductCodeLetter(family) {
  return String(family || "").toUpperCase().replace(/[^A-Z]/g, "").charAt(0) || "X";
}

export async function generateFamilyProductCode(family) {
  const letter = familyProductCodeLetter(family);
  // Next number = (count of distinct product lines already using this letter)
  // + 1 -- a plain count, NOT (highest number seen) + 1, so six "C" codes
  // yield C007 even if the highest of them happens to be C022. Each code's
  // leading "<letter><digits>" is its line: "C004", "C004-A" and a typed
  // "C004FOO" all belong to the C004 line and are counted once.
  const rows = await SachikoLabelStock.find({
    productCode: new RegExp(`^${letter}\\d{3,}`),
  }).select("productCode").lean();
  const headRe = new RegExp(`^${letter}(\\d{3,})`);
  const seen = new Set();
  for (const { productCode } of rows) {
    const m = headRe.exec(String(productCode || "").toUpperCase());
    if (m) seen.add(Number(m[1]));
  }
  let next = seen.size + 1;
  while (seen.has(next)) next += 1;
  // Guard against colliding with a hand-entered / differently-formatted code.
  while (await SachikoLabelStock.exists({ productCode: `${letter}${String(next).padStart(3, "0")}` })) {
    next += 1;
  }
  return `${letter}${String(next).padStart(3, "0")}`;
}

// The existing row whose recipe (every signature field EXCEPT Product Code)
// matches this payload, or null. The cross-code duplicate guard the manual
// create form still needs now that Product Codes are auto-assigned and so
// never collide on their own for buildLabelStockSignature to catch.
export async function findLabelStockSpecMatch(payload) {
  const specSignature = buildLabelStockSpecSignature(normalizeRecipe(payload));
  const rows = await SachikoLabelStock.find().lean();
  return rows.find((doc) => buildLabelStockSpecSignature(normalizeRecipe(doc)) === specSignature) || null;
}

// labelStockId ("SP | LS | 000001") -- same Counter-based sequence
// routes/sachiko/sachiko_route.js's generateId("sachikoLabelStockId", "LS")
// uses for the manual create form, so ids stay in one shared sequence
// regardless of which path created the row.
export async function generateLabelStockId() {
  const counter = await Counter.findOneAndUpdate(
    { key: "sachikoLabelStockId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `SP | LS | ${String(counter.seq).padStart(6, "0")}`;
}

const parseSkuSeq = (skuCode) => {
  const match = String(skuCode || "").match(/(\d{6})(?:-[A-Z]+)?$/);
  return match ? Number(match[1]) : 0;
};

// skuCode ("SP | LS | 000001") -- same scan-the-collection scheme
// routes/sachiko/sachiko_route.js's generateSkuCode() uses for the manual
// create form (a separate mechanism from labelStockId's Counter above, kept
// identical here rather than unified, matching the existing two-mechanism
// design).
export async function generateLabelStockSkuCode() {
  let nextSeq = parseSkuSeq(
    (await SachikoLabelStock.findOne().sort({ skuCode: -1 }).select("skuCode").lean())?.skuCode,
  ) + 1;

  const maxAttempts = 10000;
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = `SP | LS | ${String(nextSeq).padStart(6, "0")}`;
    if (!(await SachikoLabelStock.exists({ skuCode: candidate }))) return candidate;
    nextSeq += 1;
  }
  throw new Error("Unable to generate unique Label Stock SKU code");
}

// Maps a *master* document's own fields onto the SachikoLabelStock recipe
// layer field names for its pool -- e.g. a FacestockMaster's {family, type,
// make, vendorId, vendorName, vendorSkuCode, size, gsm, micron} becomes
// {facestockFamily, facestockType, facestockMake, ...}. Adhesive's `gsm` is
// the one exception: Adhesive Master carries no gsm field at all (it's a
// plain typed value on the reel itself, see routes/stock/adhesiveStock.js),
// so it's threaded through separately (see masterLayerForReel below) rather
// than listed here.
const LAYER_FIELD_MAP = {
  facestock: {
    family: "facestockFamily", type: "facestockType", make: "facestockMake",
    vendorId: "facestockVendorId", vendorName: "facestockVendorName", vendorSkuCode: "facestockVendorSkuCode",
    size: "facestockSize", gsm: "facestockGsm", micron: "facestockMicron",
  },
  adhesive: {
    type: "adhesiveType", make: "adhesiveMake",
    vendorId: "adhesiveVendorId", vendorName: "adhesiveVendorName", vendorSkuCode: "adhesiveVendorSkuCode",
    viscosity: "adhesiveViscosity", cohesion: "adhesiveCohesion",
    shear: "adhesiveShear", density: "adhesiveDensity",
  },
  release: {
    type: "releaseLinerType", make: "releaseLinerMake", sensing: "releaseLinerSensing",
    vendorId: "releaseLinerVendorId", vendorName: "releaseLinerVendorName", vendorSkuCode: "releaseLinerVendorSkuCode",
    color: "releaseLinerColor", size: "releaseLinerSize", gsm: "releaseLinerGsm",
  },
};

const POOL_MASTER_MODELS = { facestock: FacestockMaster, adhesive: AdhesiveMaster, release: ReleaseMaster };

// The reel-side fields NOT already pinned down by POOL_MATCH_FIELDS (utils/
// labelStockProduction.js) -- used only to break a tie when a reel's core
// spec (Facestock family/make/vendorSkuCode/type/micron, Adhesive type,
// Release type/make/vendorSkuCode/color -- vendor included here too, since
// *that's* what's actually varying) still matches more than one master (e.g.
// three Facestock Masters sharing everything but Size).
const POOL_TIEBREAK_FIELDS = {
  facestock: ["size", "gsm", "micron"],
  adhesive: ["make", "vendorSkuCode", "viscosity", "cohesion", "shear", "density"],
  release: ["color", "size", "gsm"],
};

function normForCompare(v) {
  return v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().toUpperCase();
}

// Blank on either side = no constraint (same "no value = no narrowing" rule
// reelMatchesLayer itself uses) -- only an actual disagreement disqualifies.
function fieldsMatch(a, b) {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  return na === null || nb === null || na === nb;
}

// Multiple master rows can share every field two reels are guaranteed to
// agree on (see POOL_MATCH_FIELDS) plus Vendor -- e.g. three Facestock
// Masters at the same family/type/make/vendor/vendor SKU code, one per Size.
// Narrows using whatever of the reel's own tiebreak fields are actually set;
// if that still doesn't isolate one, picks deterministically by skuId rather
// than depending on MongoDB's unspecified return order, so the same reel
// spec always resolves to the same master.
function pickMaster(candidates, reel, tiebreakFields) {
  if (candidates.length <= 1) return candidates[0] || null;
  const narrowed = candidates.filter((m) => tiebreakFields.every((f) => fieldsMatch(reel[f], m[f])));
  const pool = narrowed.length ? narrowed : candidates;
  return pool.slice().sort((a, b) => String(a.skuId || "").localeCompare(String(b.skuId || "")))[0];
}

// Resolves a raw-material reel back to the cataloged Master row it was
// entered against (every Facestock/Adhesive/Release Liner Stock inward reel
// is created directly from a picked Master row -- see the "Add Stock"/
// masterPrefill flow in views/stock/*Stock.ejs -- so this should almost
// always find an exact one), and builds the recipe layer from THAT MASTER's
// own fields rather than the reel's own copy of them.
//
// This matters for two reasons, not just one:
//   - Editing a Label Stock (views/sachiko/labelStockView.ejs) picks every
//     layer off the Master catalog through Choices.js dropdowns -- a layer
//     built straight from a reel's own idiosyncratic field values might not
//     correspond to any selectable option there even if it's factually
//     correct, since it was never validated against master data. Basing it
//     on the actual Master row guarantees it's always exactly one of those
//     options.
//   - Two different physical reels entered against the very same Master can
//     otherwise carry slightly different incidental data (a typo'd Shelf
//     Life, a Size left blank on one inward and filled on another); rebuilding
//     from the reel every time would make the reconstructed recipe -- and so
//     buildLabelStockSpecSignature -- drift between production runs of what
//     is really the same substitution, mismatching resolveLabelStockProductCode's
//     "reuse" lookup and minting a fresh "-B", "-C", ... variant each time
//     instead of reusing the one already tracked. Master data doesn't have
//     that per-reel noise.
// Falls back to the reel's own fields only if no Master row matches at all.
export async function masterLayerForReel(pool, reel) {
  const Model = POOL_MASTER_MODELS[pool];
  const map = LAYER_FIELD_MAP[pool];

  const query = {};
  for (const reelField of Object.keys(map)) {
    if (reelField === "vendorName") continue; // denormalized display copy, not an identifying key -- vendorId already pins the vendor
    if (reelField === "gsm" && pool === "adhesive") continue; // Adhesive Master has no gsm field
    const v = reel[reelField];
    if (v !== undefined && v !== null && String(v).trim() !== "") query[reelField] = v;
  }
  const candidates = await Model.find(query).lean();
  const master = pickMaster(candidates, reel, POOL_TIEBREAK_FIELDS[pool]);

  const out = {};
  if (master) {
    for (const [srcField, layerField] of Object.entries(map)) {
      const value = master[srcField];
      out[layerField] = value === undefined || value === null ? undefined : value;
    }
  } else {
    // No cataloged Master matches this reel at all (shouldn't normally
    // happen -- see the comment above) -- fall back to the reel's own
    // recorded fields so production still succeeds.
    for (const [reelField, layerField] of Object.entries(map)) {
      const value = reel[reelField];
      out[layerField] = value === undefined || value === null ? undefined : value;
    }
  }
  // Adhesive's gsm is never on the Master either way -- always the reel's
  // own typed value.
  if (pool === "adhesive") out.adhesiveGsm = reel.gsm === undefined || reel.gsm === null ? undefined : reel.gsm;
  return out;
}

// Called by produceDeckle() once every required layer's reel is resolved
// (`resolvedLayers`: [{ layerKey, meta: LAYER_META[layerKey], reel }]).
// Reconstructs the recipe straight from those reels and compares it against
// `labelStock`'s own stored recipe:
//   - identical -> produced exactly to spec, returns `labelStock` unchanged
//     (no extra DB writes on the common path).
//   - different (e.g. same core spec, different vendor -- POOL_MATCH_FIELDS
//     doesn't check vendor, so this is a real, allowed substitution) ->
//     resolves (reusing a prior identical substitution if one's already
//     tracked, otherwise minting the next "-A"/"-B"/... variant) and returns
//     that row instead, so the produced Deckle is attributed to the material
//     that actually went into it.
export async function resolveActualLabelStock(labelStock, resolvedLayers, { dryRun = false } = {}) {
  const overrides = {};
  for (const { layerKey, meta, reel } of resolvedLayers) {
    overrides[layerKey] = await masterLayerForReel(meta.pool, reel);
  }
  const rebuilt = normalizeRecipe(rebuildRecipe(labelStock, overrides));

  if (buildLabelStockSpecSignature(rebuilt) === buildLabelStockSpecSignature(normalizeRecipe(labelStock))) {
    return labelStock;
  }

  const resolvedCode = await resolveLabelStockProductCode(rebuilt, { onExactMatch: "reuse", familyRoot: true });
  if (resolvedCode === labelStock.productCode) return labelStock; // guard only -- signatures already differ above

  const existing = await SachikoLabelStock.findOne({ productCode: resolvedCode }).lean();
  if (existing) return existing;

  // dryRun -- the caller only wants to KNOW what this combination would
  // resolve to, not commit it (the Job Card's scan-time "Producing as ..."
  // banner, re-checked on every scan/blur). Return an unsaved stand-in; the
  // variant row is minted for real at produce time, from this same path.
  if (dryRun) {
    return { ...rebuilt, _id: null, productCode: resolvedCode, skuCode: labelStock.skuCode, __dryRun: true };
  }

  return createLabelStockVariant({ ...rebuilt, productCode: resolvedCode });
}

// A variant Product Code's SKU mirrors its base row's own SKU with the same
// letter suffix ("SP | LS | 000002" -> "SP | LS | 000002-A") instead of
// taking the next sequential number off the whole collection -- keeps a
// variant's SKU visibly tied to the base it was minted from. Falls back to a
// fresh sequential SKU (generateLabelStockSkuCode) when productCode isn't a
// suffixed variant, or its base row can't be found (e.g. since deleted).
const VARIANT_SKU_SUFFIX_RE = /^(.*[^-])-([A-Z]+)$/;

export async function resolveLabelStockSkuCode(productCode) {
  const match = VARIANT_SKU_SUFFIX_RE.exec(String(productCode || ""));
  if (match) {
    const [, base, suffix] = match;
    const baseRow = await SachikoLabelStock.findOne({ productCode: base }).select("skuCode").lean();
    if (baseRow?.skuCode) return `${baseRow.skuCode}-${suffix}`;
  }
  return generateLabelStockSkuCode();
}

// The one place a derived (production/allotment) variant row is written.
// Signatures are hashed off the DRAFT DOCUMENT's own toObject() rather than
// the payload handed in, so what's stored and what was hashed are the same
// thing by construction -- see normalizeRecipe above for why that matters.
// materialSignature is filled in here too (routes/sachiko/sachiko_route.js
// sets it on every manually created/edited row; a variant minted here is no
// different, and leaving it blank would hide the row from anything keying off
// "same physical material stack").
async function createLabelStockVariant(payload) {
  const doc = new SachikoLabelStock({
    labelStockId: await generateLabelStockId(),
    skuCode: await resolveLabelStockSkuCode(payload.productCode),
    ...payload,
  });
  const snapshot = doc.toObject();
  doc.labelStockSignature = buildLabelStockSignature(snapshot);
  doc.materialSignature = buildMaterialSignature(snapshot);
  await doc.save();
  return doc.toObject();
}

// ---------------------------------------------------------------------------
// Every material combination a set of allotted reels can make.
//
// Assign Production's raw-material pickers are checkboxes, not single-select
// (views/inventory/orders/assignProduction.ejs), so one order can hold several
// reels per layer -- and the operator is free to laminate any facestock reel
// against any adhesive drum against any release liner reel out of what's
// allotted. Two facestock x two adhesive x two release liner isn't one
// combination, it's eight, and each one that differs from the SKU's own stored
// recipe is materially a different label stock that needs its own "-A"/"-B"/...
// Product Code tracked up front -- not discovered later, one at a time, as
// each Deckle happens to get laminated.
//
// `pickedLayers` is [{ layerKey, pool, reels: [...] }], only the layers that
// actually have reels allotted; every other layer of the recipe is taken from
// `labelStock` itself (it'll be produced to spec). Resolution is sequential on
// purpose: each created variant claims a letter that the next combination's
// lookup has to see.
// ---------------------------------------------------------------------------
export async function resolveLabelStockCombinations(labelStock, pickedLayers, { maxCombinations = 200 } = {}) {
  const empty = { combinations: [], created: [], reused: [], truncated: false };
  if (!labelStock || !pickedLayers?.length) return empty;

  // One axis per picked layer. Several reels of a layer routinely resolve to
  // the very same Master-based spec (two drums of the same adhesive, say) --
  // those are one option, not two, or the product below would explode into
  // duplicates of a single combination.
  const axes = [];
  for (const { layerKey, pool, reels } of pickedLayers) {
    const options = new Map();
    for (const reel of reels) {
      const layer = await masterLayerForReel(pool, reel);
      const key = layerOptionKey(pool, layer);
      if (!options.has(key)) options.set(key, { layer, rollIds: [] });
      options.get(key).rollIds.push(reel.rollId);
    }
    if (options.size) axes.push({ layerKey, options: [...options.values()] });
  }
  if (!axes.length) return empty;

  const totalCombinations = axes.reduce((n, axis) => n * axis.options.length, 1);
  let combos = [{ layers: {}, rollIds: {} }];
  for (const axis of axes) {
    const next = [];
    for (const combo of combos) {
      for (const option of axis.options) {
        if (next.length >= maxCombinations) break;
        next.push({
          layers: { ...combo.layers, [axis.layerKey]: option.layer },
          rollIds: { ...combo.rollIds, [axis.layerKey]: option.rollIds },
        });
      }
    }
    combos = next;
  }

  // The SKU's own spec seeds `seen`: the combination that reproduces it isn't
  // a variant, it's the row we already have. Every later combination that
  // collapses onto an earlier one's signature is skipped the same way, so a
  // combination is only ever resolved (and at most one row written) once.
  const seen = new Set([buildLabelStockSpecSignature(normalizeRecipe(labelStock))]);
  const combinations = [];
  for (const combo of combos) {
    const recipe = normalizeRecipe(rebuildRecipe(labelStock, combo.layers));
    const signature = buildLabelStockSpecSignature(recipe);
    if (seen.has(signature)) continue;
    seen.add(signature);

    const productCode = await resolveLabelStockProductCode(recipe, { onExactMatch: "reuse", familyRoot: true });
    // "reuse" hands back an existing family member's code when this exact
    // recipe is already tracked; anything else is a letter nothing holds yet.
    const existing = await SachikoLabelStock.findOne({ productCode }).lean();
    const row = existing || (await createLabelStockVariant({ ...recipe, productCode }));
    combinations.push({ productCode, created: !existing, rollIds: combo.rollIds, labelStock: row });
  }

  return {
    combinations,
    created: combinations.filter((c) => c.created).map((c) => c.productCode),
    reused: combinations.filter((c) => !c.created).map((c) => c.productCode),
    // More combinations than were resolved -- the rest are left untracked
    // rather than silently minting an unbounded number of Product Codes.
    truncated: totalCombinations > combos.length,
  };
}
