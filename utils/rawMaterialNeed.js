// How much raw material a deckle job will eat, worked out from the deckle
// itself (how many webs of what width and length) and the SKU's recipe GSMs.
//
// The formulas are the ones in "raw material formula.xlsx" (Sheet1):
//   SQ.MTR / KG = 1000 / GSM        ->  kg = area(m2) * gsm / 1000
//   WASTAGE %   = 3                 ->  applied to every layer
//   ADH. COATING: XX / 60 * 100     ->  wet adhesive from the dry coat weight
// The sheet's other columns (Rs/kg, expenses, margin, sale rate) are costing,
// not quantity, and are deliberately not modelled here.
//
// Everything comes back in KILOGRAMS, which is what the raw pools actually
// hold: FacestockStock/AdhesiveStock/ReleaseLinerStock `reelMtrs` is really
// kg (see routes/stock/semiFinishedStock.js), as is every usage figure on a
// job card.

// Trim/start-up loss allowed on every layer -- WASTAGE % in the sheet.
export const WASTAGE_PCT = 3;
// Solids in the wet adhesive: the sheet's "XX / 60 * 100 = ADH. COATING", i.e.
// a 20 gsm dry coat needs 33.3 gsm of wet adhesive off the drum.
export const ADHESIVE_SOLIDS_PCT = 60;

const num = (v) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : null);
const round2 = (n) => Math.round(n * 100) / 100;

// Which recipe layers a roll type calls for, and where each one's GSM lives.
// Mirrors LAYER_ORDER in utils/labelStockProduction.js -- keep in step.
const LAYER_ORDER = {
  NORMAL: ["facestock", "adhesive", "releaseLiner"],
  "DOUBLE RELEASE": ["facestock", "adhesive", "releaseLiner", "adhesive2", "releaseLiner2"],
  "DOUBLE FACESTOCK": ["facestock", "adhesive", "facestock2", "adhesive2", "releaseLiner"],
};

const LAYER_META = {
  facestock: {
    title: "Facestock",
    swatch: "facestock",
    gsmField: "facestockGsm",
    spec: (s) => [s?.facestockFamily, s?.facestockType, s?.facestockMake].filter(Boolean).join(" / "),
    // A facestock described in microns instead of GSM can't be weighed without
    // its density, so it is reported as "no GSM" rather than guessed at.
    altField: "facestockMicron",
  },
  adhesive: {
    title: "Adhesive",
    swatch: "adhesive",
    gsmField: "adhesiveGsm",
    spec: (s) => [s?.adhesiveType, s?.adhesiveMake].filter(Boolean).join(" / "),
    // The recipe's GSM is the DRY coat weight; the drum holds wet adhesive.
    wet: true,
  },
  releaseLiner: {
    title: "Release Liner",
    swatch: "release",
    gsmField: "releaseLinerGsm",
    spec: (s) => [s?.releaseLinerType, s?.releaseLinerMake].filter(Boolean).join(" / "),
  },
};

const specFieldFor = {
  facestock: "facestock",
  facestock2: "facestock2",
  adhesive: "adhesive",
  adhesive2: "adhesive2",
  releaseLiner: "releaseLiner",
  releaseLiner2: "releaseLiner2",
};

// The webs this job actually laminates: one entry per deckle layout (a mixed-web
// plan runs several widths), falling back to the batch's own single web for a
// row saved before layouts existed.
export function webRunsFor(pp) {
  const layouts = Array.isArray(pp?.deckleLayout) ? pp.deckleLayout : [];
  const runs = layouts
    .map((L) => ({
      width: num(L.deckleSize) ?? num(pp.deckleSize),
      length: num(L.deckleRunningMeter) ?? num(pp.deckleRunningMeters),
      webs: Math.max(1, Math.floor(num(L.count) || 1)),
    }))
    .filter((r) => r.width > 0 && r.length > 0);
  if (runs.length) return runs;

  const width = num(pp?.deckleSize);
  const length = num(pp?.deckleRunningMeters);
  const webs = Math.max(1, Math.floor(num(pp?.noOfRolls) || 1));
  return width > 0 && length > 0 ? [{ width, length, webs }] : [];
}

// Returns null when the deckle isn't described well enough to weigh (no size or
// no web length yet) -- the caller shows nothing rather than a made-up number.
export function computeRawMaterialNeed(pp, item) {
  const runs = webRunsFor(pp);
  if (!runs.length) return null;

  const areaSqM = round2(runs.reduce((a, r) => a + (r.width / 1000) * r.length * r.webs, 0));
  const webMetres = round2(runs.reduce((a, r) => a + r.length * r.webs, 0));
  const waste = 1 + WASTAGE_PCT / 100;

  const rollType = item?.rollType || "NORMAL";
  const rows = (LAYER_ORDER[rollType] || LAYER_ORDER.NORMAL).map((key) => {
    const meta = LAYER_META[key.replace(/2$/, "")];
    const spec = item?.[specFieldFor[key]] || {};
    const gsm = num(spec[meta.gsmField]);
    // Dry kg off the GSM, then the same again with wastage -- the number to
    // actually pull is the second one.
    const kg = gsm != null ? round2((areaSqM * gsm) / 1000 * waste) : null;
    const wetGsm = meta.wet && gsm != null ? round2((gsm / ADHESIVE_SOLIDS_PCT) * 100) : null;
    return {
      key,
      title: meta.title + (key.endsWith("2") ? " (Layer 2)" : ""),
      swatch: meta.swatch,
      spec: meta.spec(spec) || "—",
      gsm,
      // Only set when the layer has no GSM to weigh from -- e.g. a facestock
      // described in microns.
      micron: gsm == null && meta.altField ? num(spec[meta.altField]) : null,
      kg,
      // Adhesive only: what comes off the drum, wet.
      wetGsm,
      wetKg: wetGsm != null ? round2((areaSqM * wetGsm) / 1000 * waste) : null,
    };
  });

  // What will be drawn from stock: every layer at its pullable weight, which
  // for the adhesive is the wet figure.
  const drawn = rows.map((r) => (r.wetKg != null ? r.wetKg : r.kg)).filter((v) => v != null);
  return {
    areaSqM,
    webMetres,
    runs,
    rows,
    wastagePct: WASTAGE_PCT,
    adhesiveSolidsPct: ADHESIVE_SOLIDS_PCT,
    totalKg: drawn.length ? round2(drawn.reduce((a, b) => a + b, 0)) : null,
    // True when a layer could not be weighed, so the total is understated and
    // the page can say so instead of quietly showing a short number.
    incomplete: rows.some((r) => r.kg == null),
  };
}
