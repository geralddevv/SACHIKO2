// Offline bench + invariant check for utils/deckleOptimizer.
//
//   node scripts/deckle-optimizer-bench.js            # run every scenario
//   node scripts/deckle-optimizer-bench.js --verbose  # print each layout
//
// Touches no database and no environment -- the optimizer is a pure function,
// so this is the whole test surface. Every scenario is checked against the
// invariants that must hold for a plan to be safe to hand a planner:
//
//   1. no under-production   -- every ordered roll count is met
//   2. cap respected         -- overrun stays inside the cap, unless the
//                               rolls-per-web granularity forced it and the
//                               plan says so in `notes`
//   3. web fits              -- every layout's widths + edge trim <= deckle size
//   4. knives                -- no layout uses more than the slot limit
//   5. area balances         -- consumed == useful + every waste bucket
//   6. deterministic         -- the same input twice gives identical output
//
// Exit code is non-zero if any invariant fails, so this can gate a deploy.

import {
  planDeckleLayouts,
  OVERRUN_DEFAULTS,
} from "../utils/deckleOptimizer/index.js";

const VERBOSE = process.argv.includes("--verbose");
const MAX_SLOTS = 12;

// ---- scenarios -------------------------------------------------------------
// Widths/quantities modelled on what a Label Stock order actually looks like:
// a few hundred mm wide, a few hundred to a few thousand metres long.
const SCENARIOS = [
  {
    name: "single width, exact fit",
    orders: [{ id: "o1", width: 330, qty: 9, rm: 1000 }],
    sizes: [1000, 1010, 1020],
    note: "3 x 330 = 990 into a 1000 mm web less 5 mm trim -> 5 mm side trim",
  },
  {
    name: "single width, awkward fit",
    orders: [{ id: "o1", width: 210, qty: 12, rm: 1000 }],
    sizes: [1000, 1080, 1250],
    note: "1250: 5 x 210 = 1050 of 1245 usable; 1080: 5 x 210 of 1075",
  },
  {
    name: "two widths, complementary",
    orders: [
      { id: "o1", width: 330, qty: 6, rm: 1000 },
      { id: "o2", width: 250, qty: 6, rm: 1000 },
    ],
    sizes: [1000, 1160, 1250],
    note: "2 x 330 + 2 x 250 = 1160 packs a 1165 mm web dead",
  },
  {
    name: "three widths, mixed demand",
    orders: [
      { id: "o1", width: 420, qty: 4, rm: 1000 },
      { id: "o2", width: 305, qty: 7, rm: 1000 },
      { id: "o3", width: 152.4, qty: 15, rm: 1000 },
    ],
    sizes: [1000, 1250, 1400, 1600],
    note: "decimal width, three-way packing",
  },
  {
    name: "rolls-per-web granularity forces overrun",
    orders: [{ id: "o1", width: 300, qty: 4, rm: 250 }],
    sizes: [1000],
    note: "1000 m web / 250 m roll = 4 rolls per position; 4 ordered -> 1 position",
  },
  {
    name: "two roll lengths -> separate layouts",
    orders: [
      { id: "o1", width: 300, qty: 8, rm: 500 },
      { id: "o2", width: 400, qty: 6, rm: 250 },
    ],
    sizes: [1000, 1250],
    note: "one layout cannot wind two R. Meters",
  },
  {
    name: "many small rolls, slot-limited",
    orders: [{ id: "o1", width: 50, qty: 60, rm: 1000 }],
    sizes: [1000],
    note: "995 usable would take 19 knives; the 12-slot limit binds instead",
  },
  {
    name: "wide roll, only the big size fits",
    orders: [
      { id: "o1", width: 900, qty: 3, rm: 1000 },
      { id: "o2", width: 300, qty: 3, rm: 1000 },
    ],
    sizes: [500, 800, 1250],
    note: "500/800 must be reported infeasible, 1250 must win",
  },
  {
    name: "six widths, realistic spread",
    orders: [
      { id: "o1", width: 480, qty: 5, rm: 2000 },
      { id: "o2", width: 355, qty: 8, rm: 2000 },
      { id: "o3", width: 305, qty: 11, rm: 2000 },
      { id: "o4", width: 210, qty: 14, rm: 2000 },
      { id: "o5", width: 152.4, qty: 22, rm: 2000 },
      { id: "o6", width: 101.6, qty: 30, rm: 2000 },
    ],
    sizes: [1000, 1250, 1400, 1600, 1800],
    drm: 2000,
    note: "stress: six widths, wide size choice, 2000 m web and 2000 m rolls",
  },
  {
    name: "0% overrun means none at all",
    orders: [{ id: "o1", width: 210, qty: 12, rm: 1000 }],
    sizes: [1000, 1080, 1250],
    overrun: { pct: 0 },
    note: "must land exactly on 12 rolls -- no spare, since 0% means 0",
  },
  {
    name: "roll cap bites before the percentage",
    orders: [{ id: "o1", width: 210, qty: 100, rm: 1000 }],
    sizes: [1000],
    overrun: { pct: 0.5, maxExtraRolls: 2 },
    note: "50% would allow 50 spares; the 2-roll ceiling is what actually holds",
  },
  {
    name: "roll longer than the web -> refused",
    orders: [{ id: "o1", width: 300, qty: 4, rm: 2000 }],
    sizes: [1000],
    drm: 1000,
    expectFail: true,
    note: "a 2000 m roll cannot come off a 1000 m web",
  },
  {
    name: "no running metres recorded",
    orders: [
      { id: "o1", width: 330, qty: 3, rm: null },
      { id: "o2", width: 250, qty: 3, rm: null },
    ],
    sizes: [1000, 1250],
    note: "falls back to one roll per knife position, lengths left blank",
  },
];

// ---- invariant checks ------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;

function check(result, scenario, opts) {
  const failures = [];
  const { plan, notes } = result;

  // A scenario that is meant to be impossible has to be refused, with a reason.
  if (scenario.expectFail) {
    if (result.ok) failures.push("expected this scenario to be refused, but it planned");
    else if (!result.error) failures.push("refused without saying why");
    return failures;
  }

  if (!result.ok) {
    failures.push(`planning failed: ${result.error}`);
    return failures;
  }

  // 1 + 2: production against what was ordered.
  const forcedNote = notes.some((n) => /overrun cap was widened/.test(n));
  for (const r of plan.rolls) {
    if (r.made < r.ordered) {
      failures.push(`under-production: ${r.width} mm made ${r.made} of ${r.ordered}`);
    }
    // Both limits apply, tighter one wins -- mirrors OVERRUN_DEFAULTS.
    const cap = r.ordered + Math.max(0, Math.min(
      Math.ceil(r.ordered * opts.pct),
      Math.floor(opts.maxExtraRolls),
    ));
    if (r.made > cap && !forcedNote) {
      failures.push(
        `overrun cap broken: ${r.width} mm made ${r.made}, cap ${cap} (ordered ${r.ordered})`,
      );
    }
  }

  // 3 + 4: every layout is physically cuttable, against ITS OWN web width.
  for (const L of plan.layouts) {
    const sum = round2(L.cuts.reduce((n, c) => n + c.width, 0));
    if (!(L.size > 0)) failures.push("layout has no deckle size of its own");
    if (round2(L.size - plan.edgeTrimTotal) !== round2(L.usable)) {
      failures.push(`layout usable width wrong: ${L.usable} for size ${L.size}`);
    }
    if (sum > L.usable + 1e-9) {
      failures.push(
        `layout overflows its web: ${sum} mm of ${L.usable} mm usable (size ${L.size})`,
      );
    }
    if (!opts.mixed && L.size !== plan.deckleSize) {
      failures.push(`single-size plan has a layout at ${L.size} mm, batch says ${plan.deckleSize} mm`);
    }
    if (!scenario.sizes.includes(L.size)) {
      failures.push(`layout uses ${L.size} mm, which was not an offered size`);
    }
    if (L.cuts.length > MAX_SLOTS) {
      failures.push(`layout uses ${L.cuts.length} knives, limit is ${MAX_SLOTS}`);
    }
    if (!(L.webs >= 1) || !Number.isInteger(L.webs)) {
      failures.push(`layout has a bad web count: ${L.webs}`);
    }
    const slots = L.cuts.map((c) => c.slot).join("");
    if (slots !== "ABCDEFGHIJKL".slice(0, L.cuts.length)) {
      failures.push(`layout slots are not A..L in order: ${slots}`);
    }
  }

  // 5: the square metres have to add up.
  const w = plan.waste;
  const rebuilt = w.usefulSqM + w.edgeSqM + w.sideTrimSqM + w.endTrimSqM + w.overrunSqM;
  if (Math.abs(rebuilt - w.consumedSqM) > 0.05) {
    failures.push(
      `area does not balance: consumed ${w.consumedSqM}, parts sum ${round2(rebuilt)}`,
    );
  }
  if (Math.abs(w.consumedSqM - w.usefulSqM - w.wasteSqM) > 0.05) {
    failures.push(`waste != consumed - useful (${w.consumedSqM} / ${w.usefulSqM} / ${w.wasteSqM})`);
  }

  // The webs the layouts describe must be the webs the plan claims.
  const layoutWebs = plan.layouts.reduce((n, L) => n + L.webs, 0);
  if (layoutWebs !== plan.webs) {
    failures.push(`web count mismatch: layouts total ${layoutWebs}, plan says ${plan.webs}`);
  }

  // sizesUsed must agree with the layouts, and the headline deckleSize must be
  // the size carrying the most webs -- that is what the batch record claims.
  const bySize = new Map();
  for (const L of plan.layouts) bySize.set(L.size, (bySize.get(L.size) || 0) + L.webs);
  if (bySize.size !== plan.sizesUsed.length) {
    failures.push(`sizesUsed lists ${plan.sizesUsed.length} size(s), layouts use ${bySize.size}`);
  }
  for (const s of plan.sizesUsed) {
    if (bySize.get(s.size) !== s.webs) {
      failures.push(`sizesUsed says ${s.webs} web(s) at ${s.size} mm, layouts say ${bySize.get(s.size)}`);
    }
  }
  if (plan.mixed !== (bySize.size > 1)) {
    failures.push(`plan.mixed is ${plan.mixed} but ${bySize.size} size(s) are in use`);
  }
  const topWebs = Math.max(...bySize.values());
  if (bySize.get(plan.deckleSize) !== topWebs) {
    failures.push(`headline deckleSize ${plan.deckleSize} mm is not the most-run web`);
  }

  return failures;
}

// Total width of web run -- the optimizer's actual objective. Comparable
// across single and mixed mode, which webs alone are not.
const planCost = (plan) => plan.layouts.reduce((n, L) => n + L.size * L.webs, 0);

// ---- run -------------------------------------------------------------------
const opts = { ...OVERRUN_DEFAULTS };
let failed = 0;

console.log("");
console.log("Deckle optimizer bench");
console.log(`overrun cap: ${opts.pct * 100}% of the order (rounded up), and at most ${opts.maxExtraRolls} spare roll(s) of any width`);
console.log("");

const head = [
  "scenario".padEnd(34),
  "mode".padStart(6),
  "size".padStart(9),
  "webs".padStart(5),
  "waste%".padStart(7),
  "avoid%".padStart(7),
  "ms".padStart(5),
  "opt".padStart(4),
].join(" ");
console.log(head);
console.log("-".repeat(head.length));

for (const s of SCENARIOS) {
  // Every scenario runs BOTH ways: one web width for the whole batch, and a
  // width chosen per layout.
  const runs = [];
  for (const mixed of [false, true]) {
    const input = {
      orders: s.orders,
      sizes: s.sizes,
      edgeTrimTotal: 5,
      deckleRunningMeters: s.drm ?? 1000,
      maxSlots: MAX_SLOTS,
      mixedSizes: mixed,
      ...(s.overrun ? { overrun: s.overrun } : {}),
    };
    const t0 = Date.now();
    const result = planDeckleLayouts(input);
    const ms = Date.now() - t0;

    // 6: determinism.
    const again = planDeckleLayouts(input);
    const deterministic = JSON.stringify(result.plan) === JSON.stringify(again.plan);

    const failures = check(result, s, { ...opts, ...(s.overrun || {}), mixed });
    if (!deterministic) failures.push(`[${mixed ? "mixed" : "single"}] output is not deterministic`);

    // 7: the shipped budgets must not cost quality. Re-solve with the search
    // effectively unbounded and confirm the defaults found an equally cheap
    // plan -- if a wider search does better, the defaults are too tight for
    // real orders and the bench should say so.
    if (result.ok) {
      const exact = planDeckleLayouts({
        ...input,
        budgets: {
          timeBudgetMs: 20000,
          nodeBudget: 20000000,
          branchWidth: 1000,
          totalTimeBudgetMs: 60000,
        },
      });
      if (exact.ok && planCost(exact.plan) < planCost(result.plan)) {
        failures.push(
          `[${mixed ? "mixed" : "single"}] default budgets lost quality: `
          + `${planCost(result.plan)} mm of web vs ${planCost(exact.plan)} mm unbounded`,
        );
      }
    }
    runs.push({ mixed, result, ms, failures });
  }

  // 8: mixed mode contains the single-size answer, so it can never be worse.
  const [single, mix] = runs;
  if (single.result.ok && mix.result.ok
      && planCost(mix.result.plan) > planCost(single.result.plan)) {
    mix.failures.push(
      `mixed is WORSE than single: ${planCost(mix.result.plan)} mm of web vs ${planCost(single.result.plan)} mm`,
    );
  }

  const failures = [...single.failures, ...mix.failures];

  for (const { mixed, result, ms } of runs) {
    const tag = (mixed ? "mixed" : "single").padStart(6);
    if (s.expectFail) {
      if (!mixed) {
        console.log(`${s.name.slice(0, 34).padEnd(34)} ${"  both"} ${"refused".padStart(9)}  ${result.error || ""}`);
      }
      continue;
    }
    if (result.ok) {
      const p = result.plan;
      const w = p.waste;
      const avoidPct = w.consumedSqM > 0 ? round2((w.avoidableSqM / w.consumedSqM) * 100) : 0;
      const sizeLabel = p.mixed ? `${p.sizesUsed.length}x mixed` : String(p.deckleSize);
      console.log(
        [
          (mixed ? "" : s.name.slice(0, 34)).padEnd(34),
          tag,
          sizeLabel.padStart(9),
          String(p.webs).padStart(5),
          String(w.wastePct).padStart(7),
          String(avoidPct).padStart(7),
          String(ms).padStart(5),
          (result.stats.proven ? "yes" : "no").padStart(4),
        ].join(" "),
      );
    } else {
      console.log(`${(mixed ? "" : s.name.slice(0, 34)).padEnd(34)} ${tag} ${"FAILED".padStart(9)}  ${result.error}`);
    }
  }

  const result = single.result;

  if (VERBOSE && result.ok) {
    console.log(`     ${s.note}`);
    for (const L of result.plan.layouts) {
      const cuts = L.cuts.map((c) => `${c.slot}=${c.width}`).join(" ");
      console.log(
        `     x${L.webs} webs | ${cuts} | cut ${L.cutSum} trim ${L.sideTrim} | ${L.rm ? `${L.rm} m x ${L.rollsPerWeb}/pos` : "no length"}`,
      );
    }
    for (const r of result.plan.rolls) {
      console.log(
        `     ${r.width} mm: ordered ${r.ordered}, made ${r.made}${r.extra ? ` (+${r.extra})` : ""}`,
      );
    }
    for (const n of result.notes) console.log(`     note: ${n}`);
    console.log("");
  }

  for (const f of failures) {
    failed += 1;
    console.log(`     !! ${f}`);
  }
}

console.log("");
if (failed) {
  console.log(`${failed} invariant failure(s).`);
  process.exit(1);
}
console.log("All invariants hold.");
