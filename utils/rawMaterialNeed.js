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
// Weights come back in KILOGRAMS, which is what the raw pools actually hold:
// FacestockStock/AdhesiveStock/ReleaseLinerStock `reelMtrs` is really kg (see
// routes/stock/semiFinishedStock.js), as is every usage figure on a job card.
//
// SQUARE METRES ride alongside them, and are what Assign Production shows and
// tallies against. Area is the quantity a lamination actually consumes: every
// layer covers the whole deckle, so each needs the job's area plus wastage,
// whatever its GSM. It is also the only unit that compares reels of different
// widths -- a 2,300 m reel of 510 mm web is less material than a 2,000 m reel
// of 660 mm, which bare running metres would get backwards. Stock is held in
// kg and converted for display with kgToSqMetres(); nothing about how material
// is received or deducted changes.

// Trim/start-up loss allowed on every layer. The sheet's own WASTAGE % column
// (D2/D3/D4) says 3, but it is applied there to the RATE, as a costing adder;
// as a quantity the shopfloor pulls 1% over theoretical, so that is what this
// is set to. Change it here and every figure on Assign Production follows --
// it is the only place the number lives.
export const WASTAGE_PCT = 1;
// Solids in the wet adhesive: the sheet's "XX / 60 * 100 = ADH. COATING", i.e.
// a 20 gsm dry coat needs 33.3 gsm of wet adhesive off the drum.
export const ADHESIVE_SOLIDS_PCT = 60;

const num = (v) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : null);
const round2 = (n) => Math.round(n * 100) / 100;

// kg -> square metres. The exact inverse of `kg = area x gsm / 1000`:
//
//     area (m2) = kg x 1000 / gsm
//
// Width does not enter into it, which is the point: a reel's area is what it
// can cover however it is slit, so reels of different widths are directly
// comparable and every reel carrying a GSM converts -- no width needed, and
// none available for an adhesive drum anyway.
//
// Returns null without a GSM to divide by: a facestock reel recorded in
// microns has no weight-per-area, so its area is unknown and must be reported
// as such rather than guessed at.
export function kgToSqMetres(kg, gsm) {
  const k = num(kg);
  const g = num(gsm);
  if (!(k > 0) || !(g > 0)) return null;
  return round2((k * 1000) / g);
}

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

// The webs this job laminates, at ONE width.
//
// A mixed-web plan stores a width per layout (660 mm × 2 + 635 mm × 1), but
// that is a SLITTING optimisation -- it decides how each web is cut up, not
// what the laminator runs. The laminator mounts one facestock reel and runs
// the whole lot off it, which is also all Assign Production can allot against:
// the reel picker below the requirement is one pool with one Size filter.
// Budgeting across two widths described a job nobody runs and made the figure
// impossible to buy to.
//
// So every deckle is budgeted at one width: the batch's own `deckleSize`, or
// the widest layout if some layout is wider than that. `deckleSize` holds
// whichever width carries the MOST webs, not the largest, so on a plan whose
// odd web is wider it would under-state -- and being short of facestock on the
// floor is the one outcome worth spending a little trim to avoid. Where they
// agree (this is the usual case, and every single-width batch) it is simply
// the deckle size on the card.
//
// The per-layout run LENGTHS are still honoured, in case a batch mixes them.
export function webRunsFor(pp) {
  const layouts = Array.isArray(pp?.deckleLayout) ? pp.deckleLayout : [];
  const layoutWidths = layouts.map((L) => num(L.deckleSize)).filter((w) => w > 0);
  const width = Math.max(num(pp?.deckleSize) || 0, ...layoutWidths, 0);
  if (!(width > 0)) return [];

  // Layouts that now share a width AND a run length are one and the same web
  // as far as raw material goes -- merged, so the working shows "660 x 3"
  // rather than "660 x 2" and "660 x 1" on two lines, which reads like two
  // configs again. Only a genuinely different run length keeps its own row.
  const merged = new Map();
  for (const L of layouts) {
    const length = num(L.deckleRunningMeter) ?? num(pp.deckleRunningMeters);
    if (!(length > 0)) continue;
    const webs = Math.max(1, Math.floor(num(L.count) || 1));
    merged.set(length, (merged.get(length) || 0) + webs);
  }
  const runs = [...merged.entries()].map(([length, webs]) => ({ width, length, webs }));
  if (runs.length) return runs;

  const length = num(pp?.deckleRunningMeters);
  const webs = Math.max(1, Math.floor(num(pp?.noOfRolls) || 1));
  return length > 0 ? [{ width, length, webs }] : [];
}

// Returns null when the deckle isn't described well enough to weigh (no size or
// no web length yet) -- the caller shows nothing rather than a made-up number.
export function computeRawMaterialNeed(pp, item) {
  const runs = webRunsFor(pp);
  if (!runs.length) return null;

  const areaSqM = round2(runs.reduce((a, r) => a + (r.width / 1000) * r.length * r.webs, 0));
  const webMetres = round2(runs.reduce((a, r) => a + r.length * r.webs, 0));
  const waste = 1 + WASTAGE_PCT / 100;

  // Every layer covers the whole deckle, so the area each one needs is the
  // job's own area plus wastage -- no GSM involved, which is why a layer too
  // thin to weigh still has a requirement the shopfloor can work to.
  const needSqM = round2(areaSqM * waste);

  // ...and the same again as a LENGTH. Every layer runs the full length of
  // every web, so this is one figure for all of them. It is only meaningful
  // now that the job is budgeted at a single width (see webRunsFor): metres of
  // a 510 mm reel and metres of a 660 mm one are not the same material, so a
  // length is only comparable once the width is pinned down.
  const needMetres = round2(runs.reduce((a, r) => a + r.length * r.webs, 0) * waste);

  // That single width -- what an adhesive drum's weight is spread over to say
  // how much web it can coat.
  const budgetWidthMm = runs[0]?.width ?? null;

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

      // ---- square metres ----
      // The area this layer covers: the same for every layer (they all cover
      // the deckle), and known even where `kg` is null.
      sqM: needSqM,
      // The GSM a reel's kg is divided by to get its AREA -- the third figure
      // on the requirement line. The tally itself runs on kg and metres; see
      // `needKg` / `needMtrs` below.
      stockGsm: gsm,

      // ---- what the requirement states, and is tallied on ---------------
      // Both sides of the same material: the WEIGHT the store issues against,
      // and the LENGTH the machine runs. A reel has both, so both are compared.
      needKg: meta.wet ? (wetGsm != null ? round2((areaSqM * wetGsm) / 1000 * waste) : null) : kg,
      needMtrs: needMetres,
      // The GSM a reel's kg is turned into metres with, and the width it is
      // spread over. A web reel has a width of its own, so `mtrsWidthMm` is
      // null there -- its true length is kg / (own width x own gsm). A drum
      // has neither: it is spread over the job's web at the recipe's wet coat
      // weight, which is what these two carry for the adhesive layer.
      mtrsGsm: meta.wet ? wetGsm : gsm,
      mtrsWidthMm: meta.wet ? budgetWidthMm : null,

    };
  });

  // What will be drawn from stock: every layer at its pullable weight, which
  // for the adhesive is the wet figure.
  const drawn = rows.map((r) => (r.wetKg != null ? r.wetKg : r.kg)).filter((v) => v != null);
  return {
    areaSqM,
    webMetres,
    needSqM,
    needMetres,
    budgetWidthMm,
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
