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
const AD_SIG_FIELDS = ["adhesiveType", "adhesiveMake", "adhesiveVendorId", "adhesiveVendorSkuCode", "adhesiveShelfLife"];
const AD_SIG_NUM_FIELDS = ["adhesiveGsm", "adhesiveViscosity", "adhesiveCohesion", "adhesiveShear", "adhesiveDensity"];
const RL_SIG_FIELDS = ["releaseLinerType", "releaseLinerMake", "releaseLinerVendorId", "releaseLinerVendorSkuCode", "releaseLinerColor", "releaseLinerSize"];
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

const escapeRegExpLS = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
export async function resolveLabelStockProductCode(payload, { onExactMatch = "throw" } = {}) {
  const base = payload.productCode;
  const family = await SachikoLabelStock.find({
    productCode: new RegExp(`^${escapeRegExpLS(base)}(-[A-Z]+)?$`),
  }).lean();
  if (!family.length) return base;

  const specSignature = buildLabelStockSpecSignature(payload);
  const suffixOf = (code) => (code === base ? "" : code.slice(base.length + 1));

  const exactMatch = family.find((doc) => buildLabelStockSpecSignature(doc) === specSignature);
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
  const match = String(skuCode || "").match(/(\d{6})$/);
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
    shelfLife: "adhesiveShelfLife", viscosity: "adhesiveViscosity", cohesion: "adhesiveCohesion",
    shear: "adhesiveShear", density: "adhesiveDensity",
  },
  release: {
    type: "releaseLinerType", make: "releaseLinerMake",
    vendorId: "releaseLinerVendorId", vendorName: "releaseLinerVendorName", vendorSkuCode: "releaseLinerVendorSkuCode",
    color: "releaseLinerColor", size: "releaseLinerSize", gsm: "releaseLinerGsm",
  },
};

const POOL_MASTER_MODELS = { facestock: FacestockMaster, adhesive: AdhesiveMaster, release: ReleaseMaster };

// The reel-side fields NOT already pinned down by POOL_MATCH_FIELDS (utils/
// labelStockProduction.js) -- used only to break a tie when a reel's core
// spec (family/make/vendorSkuCode/type[/gsm/micron], vendor included here
// since *that's* what's actually varying) still matches more than one master
// (e.g. three Facestock Masters sharing everything but Size).
const POOL_TIEBREAK_FIELDS = {
  facestock: ["size", "gsm", "micron"],
  adhesive: ["shelfLife", "viscosity", "cohesion", "shear", "density"],
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
export async function resolveActualLabelStock(labelStock, resolvedLayers) {
  const rebuilt = {
    productCode: labelStock.productCode,
    rollType: labelStock.rollType,
    family: labelStock.family,
    rollOrSheet: labelStock.rollOrSheet,
    printingTechnology: labelStock.printingTechnology,
    digitalPrintType: labelStock.digitalPrintType,
  };
  for (const { layerKey, meta, reel } of resolvedLayers) {
    rebuilt[layerKey] = await masterLayerForReel(meta.pool, reel);
  }

  if (buildLabelStockSpecSignature(rebuilt) === buildLabelStockSpecSignature(labelStock)) {
    return labelStock;
  }

  const resolvedCode = await resolveLabelStockProductCode(rebuilt, { onExactMatch: "reuse" });
  if (resolvedCode === labelStock.productCode) return labelStock; // guard only -- signatures already differ above

  const existing = await SachikoLabelStock.findOne({ productCode: resolvedCode }).lean();
  if (existing) return existing;

  const payload = { ...rebuilt, productCode: resolvedCode };
  const labelStockId = await generateLabelStockId();
  const skuCode = await generateLabelStockSkuCode();
  const labelStockSignature = buildLabelStockSignature(payload);
  const created = await SachikoLabelStock.create({ labelStockId, skuCode, ...payload, labelStockSignature });
  return created.toObject();
}
