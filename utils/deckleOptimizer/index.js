// ---------------------------------------------------------------------------
// Deckle Optimizer -- automatic deckle layout planning.
//
// Deliberately a standalone module: nothing in here touches mongoose, the
// session, express or any other part of the app. It takes plain numbers in and
// gives plain numbers out, so the algorithm can be developed, benchmarked
// (scripts/deckle-optimizer-bench.js) and replaced without disturbing the
// manual Set Deckle planner it sits beside. The manual planner
// (views/inventory/orders/deckleSetForm.ejs + POST
// /labels/production/deckle-set) remains the system of record and keeps
// working with this module switched off.
//
// ---- The problem -----------------------------------------------------------
//
// One Product Code's loose orders each want `quantity` finished rolls, cut to
// `paperSize` mm wide and `runningMeters` m long. They are all slit off one
// laminated web -- the "deckle" -- whose width must be one of the facestock
// sizes actually in stock, minus a fixed edge trim on both sides. A "layout"
// is one A..L knife arrangement across that web; a layout is run for some
// number of webs, and each knife position on each web yields
// floor(deckleRunningMeters / plannedRunningMeter) finished rolls.
//
// That is a one-dimensional cutting-stock problem, with three wrinkles the
// textbook version does not have:
//
//   1. DECKLE SIZE IS AN OUTER CHOICE. By default one size serves the whole
//      batch: each candidate is solved independently and the cheapest wins.
//      With `mixedSizes` the union of every size's patterns goes into one
//      solve and each layout may come off a different width -- see below.
//
//   2. ONE ROLL LENGTH PER LAYOUT. `plannedRunningMeter` is a property of the
//      layout, not of a knife position, so two orders wanting different roll
//      lengths can never share a layout. Orders are therefore partitioned by
//      running metres and each partition is solved as its own instance.
//
//   3. DEMAND IS IN ROLLS, SUPPLY IS IN POSITION-WEBS. One knife position on
//      one web makes `rollsPerWeb` rolls, so a width wanting 10 rolls at 4
//      rolls/web needs 3 position-webs -- and gets 12 rolls, 2 more than
//      ordered. This granularity, not the packing, is usually what forces an
//      overrun.
//
// ---- The objective ---------------------------------------------------------
//
// Minimise facestock consumed, which is `deckleSize x deckleRunningMeters x
// webs`. Because under-production is never allowed and the ordered roll area
// is fixed, the useful area is the same in every feasible plan -- so
// minimising consumption is exactly equivalent to minimising total waste
// (edge trim + side trim + end-of-web remainder + overrun). With
// deckleRunningMeters fixed by the planner, the whole objective collapses to
// minimising the summed width of the webs run -- `deckleSize x totalWebs` when
// one size serves the batch, and the sum of each layout's own width when it
// does not. solver.js calls that quantity `cost`.
//
// ---- Mixed webs (`mixedSizes`) ---------------------------------------------
//
// A batch normally laminates every web at one width. `mixedSizes` lifts that:
// the solver sees every size's patterns at once and prices each by the width
// it comes off, so a layout that only wants 500 mm of rolls can be run on a
// 510 mm web while its neighbour uses 1250 mm. The all-one-size answer is
// still inside that search space, so mixed can only match or beat single --
// never lose. What it costs is real-world handling: more than one facestock
// reel spec to pull for one job, and a batch whose single `deckleSize` field
// no longer tells the whole story. Hence off by default and per-layout sizes
// persisted on PendingProduction.deckleLayout[].deckleSize, so Slitting
// Allocation pre-fills each row at the width it will actually run.
//
// ---- Overrun ---------------------------------------------------------------
//
// Never under-produce; overrun is allowed up to a cap (see OVERRUN_DEFAULTS).
// Where the rolls-per-web granularity makes even the cap unreachable, the cap
// is widened for that width rather than the plan being declared infeasible --
// and `notes` says so explicitly, so an unavoidable overrun is never silent.
// ---------------------------------------------------------------------------

import {
  WIDTH_SCALE,
  toScaled,
  fromScaled,
  enumeratePatterns,
  purePatterns,
  dedupePatterns,
} from "./patterns.js";
import { solveCuttingStock } from "./solver.js";

// Knife positions across one deckle web. Mirrors CUT_SLOTS in
// routes/system/slitting.js -- duplicated rather than imported from there, so
// this module keeps its no-app-imports rule. A layout can never name more
// positions than there are letters here, so it is also the hard ceiling on
// `maxSlots`.
export const SLOT_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
export const DEFAULT_MAX_SLOTS = SLOT_NAMES.length;

// Length of one deckle web, in metres, when the planner does not say
// otherwise. A planner-facing default, editable on the Set Deckle page.
export const DEFAULT_DECKLE_RUNNING_METERS = 1000;

// Two LIMITS on how many rolls of a width may be made over what was ordered.
// Both are ceilings and the tighter one binds, which is how a planner reading
// "Max Overrun 10%" and "Max Extra Rolls 5" would expect them to combine:
//
//   allowed extra = min( ceil(qty * pct), maxExtraRolls )
//
// The percentage scales with the order and is what usually governs; the roll
// cap is the absolute stop that keeps a big order from authorising a pile of
// spares. Either set to 0 means no overrun at all.
//
// The percentage allowance is rounded UP, so even a 3-roll order gets a whole
// roll of room to play with rather than nothing.
export const OVERRUN_DEFAULTS = {
  pct: 0.1,
  maxExtraRolls: 5,
};

export const BUDGET_DEFAULTS = {
  // Per cutting-stock instance (one roll length, one candidate deckle size).
  timeBudgetMs: 700,
  nodeBudget: 250000,
  // Patterns tried per branch-and-bound node, least-waste first.
  branchWidth: 14,
  // Whole-request ceiling across every size and roll-length group.
  totalTimeBudgetMs: 5000,
};

// Guard rails matching the Set Deckle page's own client-side checks, so the
// optimizer refuses the same nonsense the manual form does.
const MIN_DECKLE_MM = 25;
const MAX_DECKLE_MM = 2000;
const MAX_RM = 1000000;

// ---- kill switch ----------------------------------------------------------
// This module is new and runs on a production server, so it ships with an
// off-switch that needs no code change: set DECKLE_AUTO_ENABLED=false in .env
// and restart. Everything else -- the manual planner, the batch POST, the
// slitting hand-off -- is untouched by the flag and keeps working. Enabled
// unless explicitly switched off.
const OFF_VALUES = new Set(["false", "0", "off", "no", "disabled"]);

export function isDeckleAutoEnabled() {
  const raw = String(process.env.DECKLE_AUTO_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !OFF_VALUES.has(raw);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const isPos = (n) => Number.isFinite(n) && n > 0;

// Orders wanting the same roll length share layouts; orders wanting different
// lengths cannot (see wrinkle 2 above). Grouped on the rounded metre value so
// floating-point noise in stored data does not split a group in two.
const rmKey = (rm) => (isPos(rm) ? String(round2(rm)) : "NONE");

// ---------------------------------------------------------------------------
// planDeckleLayouts -- the module's whole public surface.
//
//   orders    [{ id, width, qty, rm }]  width mm, qty finished rolls, rm
//                                       metres per roll (null when unknown)
//   sizes     candidate deckle widths in mm (the page's "Available Sizes")
//   edgeTrimTotal  mm lost across BOTH edges of every web
//   deckleRunningMeters  length of one web, metres
//   maxSlots  knife positions available
//   overrun   { pct, rolls } cap, see OVERRUN_DEFAULTS
//   budgets   see BUDGET_DEFAULTS
//
// Returns:
//   { ok, error?, notes[], plan?, candidates[], stats }
// where `plan` is
//   { deckleSize, usableWidth, deckleRunningMeters, webs, layouts[], waste, rolls[] }
// and each layout is { cuts: [{ slot, width }], drm, rm, webs, ... } -- the
// exact shape POST /labels/production/deckle-set already stores in
// PendingProduction.deckleLayout.
// ---------------------------------------------------------------------------
export function planDeckleLayouts({
  orders,
  sizes,
  edgeTrimTotal = 5,
  deckleRunningMeters = DEFAULT_DECKLE_RUNNING_METERS,
  maxSlots = DEFAULT_MAX_SLOTS,
  overrun,
  budgets,
  // Let each layout come off whatever deckle width suits it, instead of
  // forcing one width on the whole batch. Off by default: a single-size batch
  // is one facestock reel spec to pull and one number on the job card, so the
  // extra handling has to be worth it. See "Mixed webs" below.
  mixedSizes = false,
} = {}) {
  const startedAt = Date.now();
  const notes = [];
  const B = { ...BUDGET_DEFAULTS, ...(budgets || {}) };
  const OV = { ...OVERRUN_DEFAULTS, ...(overrun || {}) };

  // ---- validate the scalars ----
  const drm = Number(deckleRunningMeters);
  if (!isPos(drm) || drm > MAX_RM) {
    return fail("Deckle R.M. must be a length greater than 0.", notes);
  }
  const edge = Number(edgeTrimTotal);
  if (!Number.isFinite(edge) || edge < 0) {
    return fail("Edge trim must be 0 mm or more.", notes);
  }
  // Clamped to the number of knife letters that exist -- a layout with more
  // positions than SLOT_NAMES could not be written down, let alone cut.
  const slots = Math.min(Math.floor(Number(maxSlots)), SLOT_NAMES.length);
  if (!isPos(slots)) return fail("Knife positions must be 1 or more.", notes);
  if (!Number.isFinite(OV.pct) || OV.pct < 0) OV.pct = OVERRUN_DEFAULTS.pct;
  if (!Number.isFinite(OV.maxExtraRolls) || OV.maxExtraRolls < 0) {
    OV.maxExtraRolls = OVERRUN_DEFAULTS.maxExtraRolls;
  }
  const mixed = mixedSizes === true;

  // ---- validate + normalise the candidate deckle sizes ----
  const sizeList = [
    ...new Set(
      (Array.isArray(sizes) ? sizes : [])
        .map((s) => round2(Number(s)))
        .filter((s) => isPos(s)),
    ),
  ].sort((a, b) => a - b);
  if (!sizeList.length) {
    return fail("Add at least one deckle size before planning.", notes);
  }
  const usableSizes = sizeList.filter(
    (s) => s >= MIN_DECKLE_MM && s <= MAX_DECKLE_MM && s - edge > 0,
  );
  if (!usableSizes.length) {
    return fail(
      `No usable deckle size — every candidate is outside ${MIN_DECKLE_MM}–${MAX_DECKLE_MM} mm or smaller than the ${round2(edge)} mm edge trim.`,
      notes,
    );
  }
  if (usableSizes.length < sizeList.length) {
    notes.push(
      `Ignored ${sizeList.length - usableSizes.length} deckle size(s) outside ${MIN_DECKLE_MM}–${MAX_DECKLE_MM} mm or not wider than the edge trim.`,
    );
  }

  // ---- validate + group the orders ----
  const clean = [];
  let dropped = 0;
  for (const o of Array.isArray(orders) ? orders : []) {
    const width = round2(Number(o?.width));
    const qty = Math.floor(Number(o?.qty));
    const rm = isPos(Number(o?.rm)) ? round2(Number(o.rm)) : null;
    if (!isPos(width) || !isPos(qty)) { dropped += 1; continue; }
    if (rm !== null && rm > MAX_RM) { dropped += 1; continue; }
    clean.push({ id: o?.id != null ? String(o.id) : null, width, qty, rm });
  }
  if (!clean.length) {
    return fail("No order has both a paper size and a roll quantity to plan from.", notes);
  }
  if (dropped) {
    notes.push(`Skipped ${dropped} order(s) with no usable paper size or roll quantity.`);
  }

  // One instance per distinct roll length -- a layout carries a single
  // plannedRunningMeter, so lengths cannot be mixed across knife positions.
  const groups = new Map();
  for (const o of clean) {
    const key = rmKey(o.rm);
    let g = groups.get(key);
    if (!g) {
      g = { key, rm: o.rm, widths: new Map() };
      groups.set(key, g);
    }
    g.widths.set(o.width, (g.widths.get(o.width) || 0) + o.qty);
  }
  if (groups.size > 1) {
    notes.push(
      `Orders span ${groups.size} different roll lengths — each gets its own layouts, since one layout can only wind a single R. Meter.`,
    );
  }

  // Prepare each group: rolls per web, the position demands, the overrun caps.
  const prepared = [];
  for (const g of groups.values()) {
    // Rolls a single knife position yields from one web. An order whose
    // running metres are unknown falls back to one roll per position, which is
    // what the manual form's own rollsPerWeb() does with the lengths blank.
    const rollsPerWeb = g.rm ? Math.max(1, Math.floor(round2(drm / g.rm))) : 1;
    if (g.rm && g.rm > drm) {
      return fail(
        `A roll of ${round2(g.rm)} m cannot be wound off a ${round2(drm)} m deckle web — raise Deckle R.M. or split those orders out.`,
        notes,
      );
    }

    const widths = [...g.widths.keys()].sort((a, b) => b - a);
    const need = [];
    const maxi = [];
    const forced = [];
    for (const w of widths) {
      const qty = g.widths.get(w);
      const minPositions = Math.ceil(qty / rollsPerWeb);
      // Both caps apply; the tighter one wins. See OVERRUN_DEFAULTS.
      const allowedExtra = Math.max(
        0,
        Math.min(Math.ceil(qty * OV.pct), Math.floor(OV.maxExtraRolls)),
      );
      const capRolls = qty + allowedExtra;
      let maxPositions = Math.floor(capRolls / rollsPerWeb);
      if (maxPositions < minPositions) {
        // The granularity, not the packing, forces the overshoot: a width
        // needing 4 rolls at 3 rolls/web must run 2 positions and make 6.
        // Widening beats refusing to plan, but it is stated out loud.
        maxPositions = minPositions;
        forced.push({ width: w, qty, made: minPositions * rollsPerWeb });
      }
      need.push(minPositions);
      maxi.push(maxPositions);
    }
    for (const f of forced) {
      notes.push(
        `${round2(f.width)} mm: ${f.qty} roll(s) ordered but a web yields ${rollsPerWeb} per knife position, so the plan makes ${f.made}. The overrun cap was widened to allow it.`,
      );
    }

    prepared.push({
      key: g.key,
      rm: g.rm,
      rollsPerWeb,
      widths,
      widthsScaled: widths.map(toScaled),
      need,
      maxi,
      qtyByWidth: g.widths,
    });
  }

  // ---- pattern sets ----
  // Every A..L layout cuttable from one deckle size, tagged with the size it
  // came off. `cost` is that size (scaled): the running metres are identical
  // for every web, so width alone ranks facestock consumed, and the solver
  // minimises total cost. Returns null when the group's widest roll cannot fit
  // this size at all.
  let patternsExamined = 0;
  let anyApproximate = false;

  const patternsForSize = (g, size) => {
    const usable = round2(size - edge);
    const usableScaled = toScaled(usable);
    const sizeScaled = toScaled(size);
    if (g.widthsScaled.some((w) => w > usableScaled)) return null;

    const maxCounts = g.widthsScaled.map((w, i) =>
      Math.min(g.maxi[i], slots, Math.floor(usableScaled / w)),
    );

    let { patterns, capped } = enumeratePatterns({
      widths: g.widthsScaled,
      maxCounts,
      usableWidth: usableScaled,
      maxSlots: slots,
      maximalOnly: false,
    });
    if (capped) {
      // Too many layouts to list exhaustively. Fall back to the ones that
      // cannot fit another roll -- a much smaller set that still contains an
      // optimum whenever overrun is not the binding constraint.
      ({ patterns } = enumeratePatterns({
        widths: g.widthsScaled,
        maxCounts,
        usableWidth: usableScaled,
        maxSlots: slots,
        maximalOnly: true,
      }));
      anyApproximate = true;
    }
    // Always keep a single-width escape hatch available (see purePatterns).
    patterns = dedupePatterns(
      patterns,
      purePatterns({
        widths: g.widthsScaled,
        maxCounts,
        usableWidth: usableScaled,
        maxSlots: slots,
      }),
    );
    for (const p of patterns) {
      p.cost = sizeScaled;
      p.size = size;
      p.usable = usable;
    }
    patternsExamined += patterns.length;
    return patterns;
  };

  const solveGroup = (g, patterns, timeBudgetMs, branchWidth) =>
    solveCuttingStock({
      patterns,
      need: g.need,
      maxi: g.maxi,
      widths: g.widthsScaled,
      maxSlots: slots,
      nodeBudget: B.nodeBudget,
      timeBudgetMs,
      branchWidth,
    });

  const candidates = [];
  let best = null;
  let budgetHit = false;

  // ---- single-size search: one solve per candidate, then compare -----------
  // Runs even when mixed webs are asked for. Mixed mode's search space CONTAINS
  // every single-size answer, so in theory it can only match or beat this --
  // but only if its search actually gets far enough, and its space is far
  // bigger for the same budget. Keeping this result to fall back on is what
  // turns "mixed can only help" from a theoretical property into a guarantee.
  {
    for (const size of usableSizes) {
      if (Date.now() - startedAt > B.totalTimeBudgetMs) {
        budgetHit = true;
        notes.push(
          `Time budget reached — deckle sizes from ${round2(size)} mm up were not evaluated.`,
        );
        break;
      }

      const usable = round2(size - edge);
      const groupSolutions = [];
      let infeasible = null;
      let totalCost = 0;
      let totalWebs = 0;
      let proven = true;

      for (const g of prepared) {
        const patterns = patternsForSize(g, size);
        if (!patterns) {
          infeasible = `${round2(g.widths[0])} mm roll does not fit the ${round2(usable)} mm usable web`;
          break;
        }
        const sol = solveGroup(g, patterns, B.timeBudgetMs, B.branchWidth);
        if (!sol.feasible) {
          infeasible = `no arrangement of the ordered widths fits a ${round2(usable)} mm usable web`;
          break;
        }
        if (!sol.proven) proven = false;
        totalCost += sol.cost;
        totalWebs += sol.webs;
        groupSolutions.push({ group: g, patterns, sol });
      }

      if (infeasible) {
        candidates.push({ size, usable, feasible: false, reason: infeasible });
        continue;
      }

      candidates.push({ size, usable, feasible: true, webs: totalWebs, consumedScore: totalCost, proven });

      if (
        !best
        || totalCost < best.consumedScore
        || (totalCost === best.consumedScore && totalWebs < best.webs)
      ) {
        best = { consumedScore: totalCost, webs: totalWebs, proven, groupSolutions };
      }
    }
  }

  // ---- mixed-size search: every width at once ------------------------------
  // The union of every size's patterns goes into ONE solve per roll-length
  // group, and the solver picks a width per layout by cost. Kept only if it
  // actually comes out cheaper than the single-size answer above -- a bigger
  // space explored under the same budget can land worse, and shipping a worse
  // plan because a checkbox was ticked would be the wrong kind of honest.
  if (mixed && usableSizes.length > 1) {
    const mixedStartedAt = Date.now();
    const groupSolutions = [];
    let failedGroup = false;
    let proven = true;
    let totalCost = 0;
    let totalWebs = 0;
    // One solve rather than one per size, so it gets a share of time and a
    // wider branch to cope with a pattern set several times the size.
    const spread = Math.min(usableSizes.length, 4);

    for (const g of prepared) {
      if (Date.now() - mixedStartedAt > B.totalTimeBudgetMs) { failedGroup = true; break; }
      let patterns = [];
      for (const size of usableSizes) {
        const ps = patternsForSize(g, size);
        if (ps) patterns = patterns.concat(ps);
      }
      if (!patterns.length) { failedGroup = true; break; }
      const sol = solveGroup(g, patterns, B.timeBudgetMs * spread, B.branchWidth * spread);
      if (!sol.feasible) { failedGroup = true; break; }
      if (!sol.proven) proven = false;
      totalCost += sol.cost;
      totalWebs += sol.webs;
      groupSolutions.push({ group: g, patterns, sol });
    }

    if (!failedGroup && (!best || totalCost < best.consumedScore)) {
      best = { consumedScore: totalCost, webs: totalWebs, proven, groupSolutions };
    } else if (best) {
      // Say so rather than quietly handing back a single-size plan: the planner
      // ticked a box and needs to know it did not change the answer.
      notes.push(
        "Mixed webs did not beat a single web width for these orders — planned at one size.",
      );
    }
  }

  if (!best) {
    const why = candidates.find((c) => !c.feasible)?.reason;
    return fail(
      why
        ? `No deckle size can carry these orders — ${why}. Add a wider size, or reduce the roll widths.`
        : "No deckle size could be planned for these orders.",
      notes,
      { candidates },
    );
  }

  if (!best.proven) {
    notes.push(
      "Search budget reached before the layout could be proved optimal — this is the best plan found, not necessarily the least-waste one.",
    );
  }
  if (anyApproximate) {
    notes.push(
      "Too many possible layouts to list exhaustively; the search was narrowed to layouts that fill the web. A better plan may exist.",
    );
  }

  const plan = buildPlan({ best, drm, edge, slots, notes });

  return {
    ok: true,
    notes,
    plan,
    candidates: candidates.sort((a, b) => a.size - b.size),
    stats: {
      elapsedMs: Date.now() - startedAt,
      patternsExamined,
      sizesEvaluated: candidates.length,
      rollLengthGroups: prepared.length,
      proven: best.proven && !anyApproximate && !budgetHit,
    },
  };
}

function fail(error, notes, extra = {}) {
  return { ok: false, error, notes, plan: null, candidates: [], stats: null, ...extra };
}

// Turn the winning per-group solutions into the layout rows the Set Deckle
// page and PendingProduction.deckleLayout both speak, and account for every
// square metre of facestock the plan consumes.
//
// Each layout carries the deckle size it is cut from -- read off the pattern,
// never off the plan -- so single-size and mixed-size plans build identically.
function buildPlan({ best, drm, edge, slots, notes }) {
  const layouts = [];
  const rolls = [];

  let consumed = 0;   // m2 of facestock drawn
  let edgeWaste = 0;  // m2 lost to the fixed edge trim
  let sideWaste = 0;  // m2 lost to uncut slack across the web
  let endWaste = 0;   // m2 lost to the unusable tail of each web
  let rollArea = 0;   // m2 wound onto finished rolls
  let overrunArea = 0; // m2 of that which nobody ordered
  const websBySize = new Map(); // deckle width -> webs run at it

  for (const { group, patterns, sol } of best.groupSolutions) {
    const k = group.rollsPerWeb;
    // Length actually wound off each knife position, and the tail left over.
    const usedLenM = group.rm ? round2(k * group.rm) : drm;
    const tailLenM = round2(drm - usedLenM);
    const producedByWidth = new Map();

    for (const [patternIdx, webs] of sol.usage) {
      const p = patterns[patternIdx];
      const cuts = [];
      for (let i = 0; i < group.widths.length; i += 1) {
        for (let c = 0; c < p.counts[i]; c += 1) cuts.push(group.widths[i]);
        if (p.counts[i] > 0) {
          producedByWidth.set(
            group.widths[i],
            (producedByWidth.get(group.widths[i]) || 0) + p.counts[i] * webs * k,
          );
        }
      }
      // Widest roll on knife A -- the convention the paper card follows.
      cuts.sort((a, b) => b - a);
      const cutSum = round2(cuts.reduce((n, w) => n + w, 0));
      const sideTrim = round2(p.usable - cutSum);

      consumed += (p.size / 1000) * drm * webs;
      edgeWaste += (edge / 1000) * drm * webs;
      sideWaste += (sideTrim / 1000) * drm * webs;
      endWaste += (cutSum / 1000) * tailLenM * webs;
      rollArea += (cutSum / 1000) * usedLenM * webs;

      websBySize.set(p.size, (websBySize.get(p.size) || 0) + webs);

      layouts.push({
        cuts: cuts.slice(0, slots).map((width, i) => ({ slot: SLOT_NAMES[i], width })),
        // The deckle width THIS layout is cut from. In single-size mode every
        // layout carries the same number; in mixed mode they differ, which is
        // why PendingProduction.deckleLayout stores it per entry.
        size: p.size,
        usable: p.usable,
        drm: round2(drm),
        // Left null when the orders never said how long a roll is -- the Set
        // Deckle form treats Deckle R.M. and R. Meter as both-or-neither.
        rm: group.rm ? round2(group.rm) : null,
        webs,
        cutSum,
        sideTrim,
        rollsPerWeb: k,
        rollsPerLayout: cuts.length * webs * k,
      });
    }

    for (const [width, ordered] of group.qtyByWidth) {
      const made = producedByWidth.get(width) || 0;
      const extra = Math.max(0, made - ordered);
      if (extra > 0) {
        overrunArea += extra * (width / 1000) * (group.rm || drm);
      }
      rolls.push({
        width,
        rm: group.rm,
        ordered,
        made,
        extra,
      });
    }
  }

  // Sort the biggest runs first -- that is the order a planner reads them in,
  // and it keeps the output stable for the bench script. Size leads once more
  // than one is in play, so a mixed plan reads grouped by web.
  layouts.sort((a, b) => b.size - a.size || b.webs - a.webs || b.cutSum - a.cutSum);
  rolls.sort((a, b) => b.width - a.width);

  // A batch still has ONE headline deckle size -- PendingProduction.deckleSize,
  // shown on the Deckle Queue, Assign Production and the job card. Where the
  // layouts differ, the one carrying the most webs is the honest answer for
  // that field, and `sizesUsed` records the full picture beside it. Ties go to
  // the wider web, so the headline never understates what the job needs.
  const sizesUsed = [...websBySize.entries()]
    .map(([size, webs]) => ({ size, webs }))
    .sort((a, b) => b.webs - a.webs || b.size - a.size);
  const headlineSize = sizesUsed[0]?.size ?? null;

  const useful = rollArea - overrunArea;
  const waste = consumed - useful;

  if (overrunArea > 0) {
    const extraRolls = rolls.reduce((n, r) => n + r.extra, 0);
    // Accurate in every case: the web count is already at its minimum, so a
    // knife position carrying an extra roll is width that would otherwise have
    // been trimmed off and scrapped. It is spare stock, not added consumption.
    notes.push(
      `Plan makes ${extraRolls} roll(s) more than ordered — they come off web width that would otherwise be trimmed away.`,
    );
  }

  if (sizesUsed.length > 1) {
    notes.push(
      `Mixed webs: ${sizesUsed.map((s) => `${round2(s.size)} mm x ${s.webs}`).join(", ")}. `
      + `The batch is recorded at ${round2(headlineSize)} mm and each layout carries its own width.`,
    );
  }

  return {
    deckleSize: headlineSize,
    usableWidth: round2(headlineSize - edge),
    mixed: sizesUsed.length > 1,
    sizesUsed,
    edgeTrimTotal: round2(edge),
    deckleRunningMeters: round2(drm),
    webs: best.webs,
    layouts,
    rolls,
    waste: {
      consumedSqM: round2(consumed),
      usefulSqM: round2(useful),
      wasteSqM: round2(waste),
      wastePct: consumed > 0 ? round2((waste / consumed) * 100) : 0,
      edgeSqM: round2(edgeWaste),
      sideTrimSqM: round2(sideWaste),
      endTrimSqM: round2(endWaste),
      overrunSqM: round2(overrunArea),
      // Side trim is the only component the layout search can actually move --
      // edge trim is fixed by the machine, the end tail by Deckle R.M. vs roll
      // length, and overrun by the rolls-per-web granularity. Surfacing it
      // separately is what tells a planner whether to change the layout or
      // change one of the inputs.
      avoidableSqM: round2(sideWaste),
    },
  };
}

export { WIDTH_SCALE, fromScaled };
