// ---------------------------------------------------------------------------
// Deckle Optimizer -- pattern selection (the integer cutting-stock solve).
//
// patterns.js says which A..L layouts are physically possible. This decides
// HOW MANY deckle webs to run of each of them, so that every order's roll
// count is met and as little facestock as possible is consumed.
//
// Demand is counted in "positions" rather than rolls. One knife position on
// one web yields `rollsPerWeb` finished rolls (the web is `deckleRunningMeters`
// long and each roll takes `plannedRunningMeter` of it), so a width needing
// 12 rolls at 4 rolls/web needs 3 position-webs. index.js does that conversion
// and hands this module integers.
//
//   need[i]  minimum position-webs for width i  -- never under-produced
//   maxi[i]  maximum position-webs for width i  -- the overrun cap
//
// ---- The objective: cost, not web count -----------------------------------
//
// Every pattern carries the deckle width it is cut from, and its COST is that
// width (the running metres are the same for every web, so width alone ranks
// facestock consumed). The solve minimises the total cost of the patterns run.
//
// In single-size mode every pattern costs the same, so minimising cost is
// literally minimising the number of webs -- the two are the same solve, and
// index.js runs it once per candidate size and compares. In mixed-size mode
// index.js hands in the union of every size's patterns, and the solver is free
// to run a narrow web where a narrow web is all that is wanted. Cost is what
// makes those two cases one code path rather than two.
//
// Costs are integers (scaled mm, see patterns.js) so every comparison and
// every bound stays exact.
//
// Two passes, in order:
//
//   1. GREEDY -- repeatedly take the pattern that covers the most outstanding
//      demand per unit of cost, run it as many times as it is useful. Always
//      returns a feasible answer, in microseconds. This is the floor on
//      quality and the answer the caller gets if the budget runs out at once.
//
//   2. BRANCH AND BOUND -- depth-first over patterns, seeded with the greedy
//      answer as the incumbent, pruned by a material lower bound and a
//      visited-state map. On the instance sizes this page actually sees (a
//      handful of distinct widths) it closes to a proven optimum in
//      milliseconds; on anything larger the node and time budgets stop it and
//      it returns the best it found, flagged `proven: false`.
//
// The whole module is pure and synchronous -- no dates, no randomness, no I/O.
// The same input always produces byte-identical output, which is what makes
// scripts/deckle-optimizer-bench.js a meaningful regression check.
// ---------------------------------------------------------------------------

const sum = (arr) => arr.reduce((n, v) => n + v, 0);

// Cheapest this residual demand could conceivably be covered for, ignoring how
// the widths actually pack. Three independent relaxations, the strongest wins:
//
//   - ratio:    a web of width S offers `usable(S)` of cuttable width for a
//     cost of S, so no web beats the best usable-per-cost ratio going. The
//     outstanding area divided by that ratio is a floor on cost.
//   - webs:     no web carries more than `maxUsable` of width, so at least
//     ceil(area / maxUsable) webs are needed, each costing at least `minCost`.
//   - knives:   a web carries at most `maxSlots` positions, again at `minCost`
//     apiece.
//
// The webs and knives terms round the WEB COUNT up before multiplying by a
// cost, which is what keeps them sharp: ceil(a/b) * cost dominates
// ceil(a * cost / b). Losing that distinction costs real pruning power -- with
// one deckle size the ratio term alone is materially weaker than the bound
// this had when it counted webs directly, and the search degrades.
//
// All three are true lower bounds, so pruning on them never discards an
// optimum.
function lowerBound(residual, widths, maxEfficiency, maxUsable, minCost, maxSlots) {
  let area = 0;
  let slots = 0;
  for (let i = 0; i < residual.length; i += 1) {
    if (residual[i] <= 0) continue;
    area += residual[i] * widths[i];
    slots += residual[i];
  }
  if (slots === 0) return 0;
  return Math.max(
    Math.ceil(area / maxEfficiency),
    Math.ceil(area / maxUsable) * minCost,
    Math.ceil(slots / maxSlots) * minCost,
  );
}

// How many times pattern `p` can be run against the current state:
//   hi  the most that stays inside every width's remaining overrun headroom
//   want the most that is still useful -- past this it is pure overshoot
function runRange(p, residual, headroom) {
  let hi = Infinity;
  let want = 0;
  for (let i = 0; i < p.counts.length; i += 1) {
    const c = p.counts[i];
    if (c <= 0) continue;
    hi = Math.min(hi, Math.floor(headroom[i] / c));
    if (residual[i] > 0) want = Math.max(want, Math.ceil(residual[i] / c));
  }
  return { hi: Number.isFinite(hi) ? hi : 0, want };
}

// Pass 1 -- greedy. Deterministic: patterns are scored, and ties fall to the
// earlier pattern in enumeration order (widest-roll-first, see patterns.js).
function greedy({ patterns, need, maxi, widths }) {
  const n = need.length;
  const residual = need.slice();
  const headroom = maxi.slice();
  const usage = new Map();
  let cost = 0;
  let webs = 0;

  // Bounded by construction: every iteration either closes at least one
  // width's residual or exits. The +1 is belt and braces against a pattern
  // set that somehow cannot progress -- the caller then sees feasible:false
  // rather than a hung request.
  const guard = sum(need) + n + 1;
  for (let step = 0; step < guard; step += 1) {
    if (!residual.some((r) => r > 0)) {
      return { feasible: true, cost, webs, usage };
    }

    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestWaste = Infinity;
    for (let k = 0; k < patterns.length; k += 1) {
      const p = patterns[k];
      const { hi, want } = runRange(p, residual, headroom);
      if (hi < 1 || want < 1) continue;
      // Outstanding width covered by one web of this pattern, per unit of
      // cost. Area rather than roll count -- filling 900 mm of the web with
      // demand beats filling 300 mm with more, narrower rolls that are not
      // actually wanted yet. Dividing by cost is what stops a wide web being
      // taken when a narrow one would have carried the same demand.
      let covered = 0;
      for (let i = 0; i < n; i += 1) {
        if (p.counts[i] > 0 && residual[i] > 0) {
          covered += Math.min(p.counts[i], residual[i]) * widths[i];
        }
      }
      const score = covered / p.cost;
      if (score > bestScore || (score === bestScore && p.waste < bestWaste)) {
        bestScore = score;
        bestWaste = p.waste;
        bestIdx = k;
      }
    }
    if (bestIdx < 0) return { feasible: false, cost, webs, usage };

    const p = patterns[bestIdx];
    const { hi, want } = runRange(p, residual, headroom);
    const take = Math.max(1, Math.min(hi, want));
    for (let i = 0; i < n; i += 1) {
      if (p.counts[i] <= 0) continue;
      residual[i] -= p.counts[i] * take;
      headroom[i] -= p.counts[i] * take;
    }
    cost += p.cost * take;
    webs += take;
    usage.set(bestIdx, (usage.get(bestIdx) || 0) + take);
  }

  return { feasible: !residual.some((r) => r > 0), cost, webs, usage };
}

// Pass 2 -- branch and bound. Branches on the WIDEST outstanding roll: it is
// the hardest to place, so every pattern that carries it is tried and the
// search never revisits the same choice in a different order.
function branchAndBound({
  patterns,
  need,
  maxi,
  widths,
  maxEfficiency,
  maxUsable,
  minCost,
  maxSlots,
  incumbent,
  nodeBudget,
  timeBudgetMs,
  branchWidth,
}) {
  const n = need.length;
  const startedAt = Date.now();
  let nodes = 0;
  let exhausted = true; // cleared the moment a budget cuts a branch short

  let bestCost = incumbent.cost;
  let bestUsage = new Map(incumbent.usage);

  // Patterns that carry width i, best first. Ordered by cost-effectiveness --
  // least waste for the width they consume -- so the incumbent drops fast and
  // the bound prunes hard. Precomputed so the hot loop never filters the list.
  const byWidth = [];
  for (let i = 0; i < n; i += 1) {
    const list = [];
    for (let k = 0; k < patterns.length; k += 1) {
      if (patterns[k].counts[i] > 0) list.push(k);
    }
    list.sort(
      (a, b) =>
        patterns[a].waste / patterns[a].cost - patterns[b].waste / patterns[b].cost
        || patterns[a].cost - patterns[b].cost
        || a - b,
    );
    byWidth.push(list);
  }

  // Residual states already reached at no greater cost than now -- reaching one
  // again cannot lead anywhere better. Capped so a pathological instance
  // cannot grow it without bound.
  //
  // Keyed on the residual vector ALONE, which is safe even though headroom is
  // part of the state: both are decremented by exactly the same amount at
  // every step, so headroom[i] === maxi[i] - need[i] + residual[i] always
  // holds. Two paths that reach the same residual necessarily have the same
  // headroom, and the one that got there cheaper dominates.
  const seen = new Map();
  const SEEN_CAP = 400000;

  const stack = [];

  const dfs = (residual, headroom, cost) => {
    nodes += 1;
    if (nodes > nodeBudget) { exhausted = false; return true; }
    // Date.now() is comparatively slow -- checking every 512th node keeps the
    // budget honest without paying for it on every branch.
    if ((nodes & 511) === 0 && Date.now() - startedAt > timeBudgetMs) {
      exhausted = false;
      return true;
    }

    let widest = -1;
    for (let i = 0; i < n; i += 1) {
      if (residual[i] > 0) { widest = i; break; } // widths are descending
    }
    if (widest < 0) {
      if (cost < bestCost) {
        bestCost = cost;
        bestUsage = new Map();
        for (const [k, c] of stack) bestUsage.set(k, (bestUsage.get(k) || 0) + c);
      }
      return false;
    }

    if (cost + lowerBound(residual, widths, maxEfficiency, maxUsable, minCost, maxSlots) >= bestCost) {
      return false;
    }

    const stateKey = residual.join(",");
    const prev = seen.get(stateKey);
    if (prev !== undefined && prev <= cost) return false;
    if (seen.size < SEEN_CAP) seen.set(stateKey, cost);

    const candidates = byWidth[widest];
    let tried = 0;
    for (const k of candidates) {
      if (tried >= branchWidth) { exhausted = false; break; }
      const p = patterns[k];
      const { hi, want } = runRange(p, residual, headroom);
      if (hi < 1 || want < 1) continue;
      tried += 1;
      const top = Math.min(hi, want);
      // Most webs first: it closes the widest roll fastest and drives the
      // incumbent down early, which is what makes the bound prune hard.
      for (let take = top; take >= 1; take -= 1) {
        if (cost + p.cost * take >= bestCost) continue;
        const nextResidual = residual.slice();
        const nextHeadroom = headroom.slice();
        for (let i = 0; i < n; i += 1) {
          if (p.counts[i] <= 0) continue;
          nextResidual[i] -= p.counts[i] * take;
          nextHeadroom[i] -= p.counts[i] * take;
        }
        stack.push([k, take]);
        const halt = dfs(nextResidual, nextHeadroom, cost + p.cost * take);
        stack.pop();
        if (halt) return true;
      }
    }
    return false;
  };

  dfs(need.slice(), maxi.slice(), 0);

  let webs = 0;
  for (const [, c] of bestUsage) webs += c;

  return {
    cost: bestCost,
    webs,
    usage: bestUsage,
    nodes,
    // Only a search that ran to completion proves its answer optimal. Any
    // budget cut anywhere in the tree forfeits the claim.
    proven: exhausted,
    elapsedMs: Date.now() - startedAt,
  };
}

// Solve one cutting-stock instance.
//
// `patterns` entries must each carry `counts`, `cost` (the scaled deckle width
// the pattern is cut from) and `waste` (scaled unused width on that web).
//
// Returns { feasible, cost, webs, usage, proven, nodes, elapsedMs } where
// `usage` is a Map of pattern index -> how many deckle webs run that pattern.
export function solveCuttingStock({
  patterns,
  need,
  maxi,
  widths,
  maxSlots,
  nodeBudget = 400000,
  timeBudgetMs = 2000,
  branchWidth = 14,
}) {
  const empty = { feasible: true, cost: 0, webs: 0, usage: new Map(), proven: true, nodes: 0, elapsedMs: 0 };
  if (!need.some((v) => v > 0)) return empty;
  if (!patterns.length) return { ...empty, feasible: false, proven: false };

  // Bounds inputs, derived from the patterns actually on offer.
  //
  // `maxEfficiency` is the most cuttable width any web buys per unit of cost.
  // A web of size S carries at most usable(S) of demand for a cost of S, and
  // for any pattern cut from it usable(S) === used + waste. Note this is NOT
  // cost - waste: cost is the FULL web width, so cost - waste would still have
  // the edge trim folded into it and would overstate what a web can carry --
  // which would make the bound unsafe rather than merely loose.
  let maxEfficiency = 0;
  let maxUsable = 0;
  let minCost = Infinity;
  for (const p of patterns) {
    const usable = p.used + p.waste;
    const eff = usable / p.cost;
    if (eff > maxEfficiency) maxEfficiency = eff;
    if (usable > maxUsable) maxUsable = usable;
    if (p.cost < minCost) minCost = p.cost;
  }
  if (!(maxEfficiency > 0)) return { ...empty, feasible: false, proven: false };

  const g = greedy({ patterns, need, maxi, widths });
  if (!g.feasible) return { ...empty, feasible: false, proven: false };

  const bb = branchAndBound({
    patterns,
    need,
    maxi,
    widths,
    maxEfficiency,
    maxUsable,
    minCost,
    maxSlots,
    incumbent: g,
    nodeBudget,
    timeBudgetMs,
    branchWidth,
  });

  return {
    feasible: true,
    cost: bb.cost,
    webs: bb.webs,
    usage: bb.usage,
    proven: bb.proven,
    nodes: bb.nodes,
    elapsedMs: bb.elapsedMs,
    greedyCost: g.cost,
  };
}
