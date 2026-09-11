// ---------------------------------------------------------------------------
// Deckle Optimizer -- cut-pattern enumeration.
//
// A "pattern" is one A..L knife layout across the usable width of a deckle
// web: how many positions each finished roll width takes. `counts[i]` is the
// number of knife positions given to width `widths[i]`. A pattern is feasible
// when the widths it holds fit inside the usable web (deckle size minus edge
// trim) and it uses no more than the machine's knife positions (CUT_SLOTS --
// 12 on this installation).
//
// Enumeration is exhaustive by design: one Product Code's loose orders rarely
// carry more than a handful of distinct paper widths, and an exhaustive list
// is what lets solver.js prove a layout is the least-waste one rather than
// merely a good guess. `patternCap` is the safety valve -- when a genuinely
// wide instance would blow past it, the caller re-runs with
// `maximalOnly: true`, which keeps only the patterns that cannot fit one more
// roll of any width. That is a far smaller set and still contains an optimal
// solution whenever overrun is unconstrained; it is a documented approximation
// only when the caller's overrun caps are tight (see index.js's `capped` note).
//
// All widths are handled as integer hundredths of a millimetre. Paper sizes
// are routinely decimals (e.g. 152.4 mm) and a plain float `<=` on a sum of
// twelve of them is not reliable -- 3 x 0.1 > 0.3 is true in IEEE754. Scaling
// once, at the edge, keeps every comparison inside the solver exact.
// ---------------------------------------------------------------------------

// Hundredths of a millimetre -- fine enough for any real slitting spec
// (10 microns), coarse enough that the sums stay well inside Number's exact
// integer range.
export const WIDTH_SCALE = 100;

export const toScaled = (mm) => Math.round(Number(mm) * WIDTH_SCALE);
export const fromScaled = (u) => Math.round(Number(u)) / WIDTH_SCALE;

// Enumerate every feasible pattern over `widths` (scaled ints, sorted
// DESCENDING -- the solver relies on that order to branch on the most
// constrained roll first).
//
//   widths      scaled roll widths, descending, deduped
//   maxCounts   per width, the most positions worth giving it in ONE pattern
//               (the caller derives this from the overrun cap -- there is no
//               point enumerating a pattern that already overshoots on its own)
//   usableWidth scaled (deckle size - total edge trim)
//   maxSlots    knife positions available (CUT_SLOTS.length)
//   patternCap  abort once this many patterns exist
//   maximalOnly keep only patterns with no room for one more roll
//
// Returns { patterns, capped }. `patterns` entries are
// { counts, slots, used, waste } with `used`/`waste` scaled. `capped` is true
// when the cap aborted the walk, in which case `patterns` is empty and the
// caller should retry with maximalOnly.
export function enumeratePatterns({
  widths,
  maxCounts,
  usableWidth,
  maxSlots,
  patternCap = 60000,
  maximalOnly = false,
}) {
  const m = widths.length;
  const patterns = [];
  const counts = new Array(m).fill(0);
  let capped = false;

  // The narrowest roll -- once the space left is under this, nothing more can
  // be added and the partial pattern is maximal.
  const narrowest = m ? widths[m - 1] : Infinity;

  const walk = (idx, used, slots) => {
    if (capped) return;
    if (idx === m) {
      if (slots === 0) return; // the empty pattern cuts nothing
      if (maximalOnly && slots < maxSlots && usableWidth - used >= narrowest) return;
      if (patterns.length >= patternCap) {
        capped = true;
        return;
      }
      patterns.push({
        counts: counts.slice(),
        slots,
        used,
        waste: usableWidth - used,
      });
      return;
    }

    const w = widths[idx];
    const room = Math.min(
      maxCounts[idx],
      maxSlots - slots,
      Math.floor((usableWidth - used) / w),
    );
    // Descending, so the widest-first branches -- and therefore the
    // lowest-waste patterns -- are produced early. solver.js takes its
    // candidate order straight from this list.
    for (let c = room; c >= 0; c -= 1) {
      counts[idx] = c;
      walk(idx + 1, used + c * w, slots + c);
      if (capped) return;
    }
    counts[idx] = 0;
  };

  walk(0, 0, 0);

  if (capped) return { patterns: [], capped: true };
  return { patterns, capped: false };
}

// Every width on its own, one position and as many positions as fit. Always
// unioned into the enumerated set: the solver's greedy pass needs a guaranteed
// escape hatch -- a pattern that cuts ONE width and nothing else -- so that a
// residual demand can always be closed without being forced to overshoot some
// other width whose cap is already spent. maximalOnly enumeration drops the
// single-position ones, which is exactly when this matters.
export function purePatterns({ widths, maxCounts, usableWidth, maxSlots }) {
  const m = widths.length;
  const out = [];
  for (let i = 0; i < m; i += 1) {
    const w = widths[i];
    const room = Math.min(maxCounts[i], maxSlots, Math.floor(usableWidth / w));
    if (room < 1) continue;
    for (const c of new Set([1, room])) {
      const counts = new Array(m).fill(0);
      counts[i] = c;
      out.push({ counts, slots: c, used: c * w, waste: usableWidth - c * w });
    }
  }
  return out;
}

// Merge pattern lists, dropping duplicates. Keyed on the counts vector AND the
// cost, because in mixed-size planning the same arrangement of rolls cut from
// two different deckle widths is two genuinely different layouts.
export function dedupePatterns(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      const key = `${p.counts.join(",")}@${p.cost ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}
