// Auto Allot -- which raw-material reels a deckle job should be run off, and
// how much of the job can actually be made once the shortest material is taken
// into account. Backs the "Auto Allot (FIFO)" button in Raw Material Allotment
// on Assign Production (views/inventory/orders/assignProduction.ejs).
//
// Deliberately standalone, the same way utils/deckleOptimizer/ is: no DOM, no
// fetch, no formatting -- plain numbers in, plain numbers out. The page does
// the measuring (what a reel weighs, what length that gives, how much of each
// width the batch runs) and the rendering; everything here is the arithmetic
// of choosing between reels, so it can be tested on its own -- see
// scripts/raw-auto-allot-bench.js.
//
// ---------------------------------------------------------------------------
// A job is not one width
// ---------------------------------------------------------------------------
// A mixed-web batch laminates several widths -- 660 x 8 + 635 x 15 + 510 x 3 --
// and the laminator mounts a reel per run. So the requirement is not one lump
// of material, it is one DEMAND PER WEB WIDTH, and a reel can only serve a
// demand it is wide enough for. That distinction is the whole reason this file
// works in demands rather than in layer totals:
//
//   * a 510 mm reel cannot make a 660 mm or a 635 mm deckle, so on this batch
//     it can only ever serve the 3 webs planned at 510;
//   * oldest-first across one flat list would happily hand those three 510
//     reels to the whole job and call it covered, which is how a plan that
//     cannot cut a single one of its 23 wider deckles reads as 100% allotted.
//
// Demands are served widest first, so the widths with the fewest usable reels
// get first claim on the reels that fit them.
//
// ---------------------------------------------------------------------------
// The rule, in order
// ---------------------------------------------------------------------------
//  1. Only reels the caller marked usable reach this file at all -- no
//     invoice, or narrower than every web in the plan, and it is not a
//     candidate. That judgement is the page's. They ride along in `skipped` so
//     the summary can say what was passed over and why.
//
//  2. Per demand: a reel must be at least as wide as that web. An exact fit
//     goes before a wider one -- a 1020 mm reel run for a 660 mm web loses
//     360 mm to trim down the whole length of the job, far more material than
//     any FIFO gain is worth. A drum has no width and serves any demand.
//
//  3. FIFO inside that -- oldest first. Paper ages, so between two reels of
//     the same spec and width the older one should move. A reel with no date
//     sorts last: an unknown age is not evidence of being old.
//
//  4. Stop the moment a demand is covered on BOTH kg and running metres -- the
//     same two-sided test the page's progress bars use. Taking more would lock
//     reels this job cannot use away from every other order, since the picker
//     hides a reel another open order holds. A reel WIDER than the web it is
//     serving only counts the weight that lands on that web (`width/reel
//     width` of it); the rest is trim, and counting it would say covered while
//     the machine ran out.
//
//     ...and the LAST reel is chosen by size, not by age. Oldest-first the
//     whole way through takes a 102 kg remnant, lands 23 kg short, and then
//     reaches for a full 630 kg reel because that is the next one by date --
//     732 kg locked to a job needing 125, with a 27 kg remnant of the same
//     paper left on the shelf. So while no single reel can finish the demand
//     the oldest is taken, and as soon as one can, the leanest of those is
//     taken instead. Old stock still moves; only the top-up reel is picked
//     for its size, which is the one place size is the whole question.
//
//  5. Every width matched to what that width can actually run (`balance`).
//     All layers go through the laminator together, so if the release liner
//     only covers two thirds of the 635 mm webs, two thirds is all of them
//     that can be made -- and allotting a full 15 webs of facestock to it
//     would reserve paper that cannot be laminated for want of liner. Worked
//     out per width, because a shortage at one width says nothing about
//     another. With `balance` off every demand is allotted in full instead.
//
// A layer with nothing pickable at all is reported as `blocked` rather than
// being allowed to scale everything else to zero: the job can't run until it
// is resolved, which is a different message from "short".
//
// Layers sharing a pool (facestock + facestock (Layer 2)) draw on one set of
// reels and a reel handed to one is never offered to the other -- the server
// rejects the same reel allotted to two layers.
// ---------------------------------------------------------------------------
(function (root) {
  "use strict";

  var round2 = function (n) { return Math.round(n * 100) / 100; };
  var MM = 0.5;                       // widths within half a mm are the same width

  // How much of `need` `got` covers, 0..1 -- the LOWER of the two sides, so a
  // demand with the weight but not the length still reads as short. A side the
  // job doesn't state (a layer with no GSM has no kg requirement) is not a
  // constraint and is left out; with neither side stated there is nothing to
  // aim at, which counts as covered.
  function coverage(got, need) {
    var parts = [];
    if (need && need.kg != null) parts.push(need.kg > 0 ? got.kg / need.kg : 1);
    if (need && need.mtrs != null) parts.push(need.mtrs > 0 ? got.mtrs / need.mtrs : 1);
    if (!parts.length) return 1;
    return Math.min.apply(null, parts);
  }

  // Can this reel be mounted for this web? A drum (no width) serves anything;
  // so does a demand with no width (a batch with no layout widths recorded).
  function eligible(reel, demand) {
    if (demand.width == null || reel.width == null) return true;
    return reel.width >= demand.width - MM;
  }

  // The weight of this reel that actually ends up on this web. All of it when
  // the reel fits the web; the rest is edge trim on a wider reel and is not
  // material this job gets to use.
  function usefulKg(reel, demand) {
    var kg = reel.kg || 0;
    if (demand.width == null || reel.width == null || reel.width <= demand.width + MM) return kg;
    return kg * (demand.width / reel.width);
  }

  // 0 when the reel is exactly this web's width, 1 when it is wider and has
  // to be trimmed to it. Nothing narrower reaches here.
  function tierOf(reel, demand) {
    return demand.width != null && reel.width != null && Math.abs(reel.width - demand.width) < MM ? 0 : 1;
  }

  // Exact fit first, then oldest, then Roll ID so the order is stable (two
  // reels off one invoice share an inward date, and an arbitrary order between
  // them would make the same press of the button pick differently each time).
  function orderFor(demand) {
    return function (a, b) {
      return tierOf(a, demand) - tierOf(b, demand)
        || (a.time || 0) - (b.time || 0)
        || String(a.rollId || "").localeCompare(String(b.rollId || ""));
    };
  }

  var widthKey = function (w) { return w == null ? "*" : String(w); };

  function planRawAllotment(input) {
    var balance = !(input && input.balance === false);
    var layers = ((input && input.layers) || []).map(function (L) {
      // Widest first: the widths with the least to choose from claim their
      // reels before a narrower web can take one it did not need.
      var demands = (L.demands || []).slice().sort(function (a, b) {
        return (b.width == null ? -1 : b.width) - (a.width == null ? -1 : a.width);
      });
      return {
        key: L.key,
        pool: L.pool,
        label: L.label || L.key,
        demands: demands,
        reels: (L.reels || []).slice(),
        skipped: L.skipped || [],
        need: demands.reduce(function (a, d) {
          return {
            kg: d.kg == null ? a.kg : round2((a.kg || 0) + d.kg),
            mtrs: d.mtrs == null ? a.mtrs : round2((a.mtrs || 0) + d.mtrs),
          };
        }, { kg: null, mtrs: null }),
      };
    });

    // One pass of the greedy, with each demand aimed at `fractionFor(width)`
    // of itself. Run twice: once at full to find what each width can manage,
    // then again at those fractions so nothing is over-allotted.
    function allocate(fractionFor) {
      var usedByPool = {};
      return layers.map(function (L) {
        var used = usedByPool[L.pool] || (usedByPool[L.pool] = {});
        return L.demands.map(function (d) {
          var f = fractionFor(d);
          var target = {
            kg: d.kg != null ? round2(d.kg * f) : null,
            mtrs: d.mtrs != null ? round2(d.mtrs * f) : null,
          };
          var got = { kg: 0, mtrs: 0 };
          var picked = [];
          var cands = L.reels.filter(function (r) { return !used[r.id] && eligible(r, d); })
            .sort(orderFor(d));
          var pool = cands.slice();
          // Where this demand would stand with `r` added to it.
          var withReel = function (r) {
            return { kg: got.kg + usefulKg(r, d), mtrs: got.mtrs + (r.mtrs || 0) };
          };
          // How the LAST reel is chosen: still exact-fit before wider (rule 2
          // outranks this -- a wider reel loses trim down the whole run,
          // which costs more than the tail it saves), then least left over,
          // then oldest, then Roll ID so the pick stays stable.
          var leaner = function (a, b) {
            return tierOf(a, d) - tierOf(b, d)
              || (a.mtrs || 0) - (b.mtrs || 0)
              || (a.kg || 0) - (b.kg || 0)
              || (a.time || 0) - (b.time || 0)
              || String(a.rollId || "").localeCompare(String(b.rollId || ""));
          };
          while (pool.length && coverage(got, target) < 1) {
            // FIFO drives the pick, with ONE exception: the reel that tops it
            // off. Oldest-first all the way through does this -- a 102 kg
            // remnant is taken first, lands 23 kg short, and the next reel by
            // date is a full 630 kg one, so 732 kg ends up locked to a job
            // needing 125 with a 27 kg remnant of the same paper still on the
            // shelf.
            //
            // So: while the next reel by date still leaves the demand short,
            // take it -- nothing is wasted by using old stock that the job
            // will consume in full. Only when that next reel would OVERSHOOT
            // is the choice reopened, and then the leanest reel that finishes
            // the job is taken instead of it.
            //
            // The test is on the next FIFO reel, not on "can any reel finish
            // it": a full reel can nearly always finish a small demand on its
            // own, so asking that question first skips straight past every
            // remnant on the shelf -- which is the opposite of what FIFO is
            // for.
            var next = pool[0];
            if (coverage(withReel(next), target) >= 1) {
              next = pool
                .filter(function (r) { return coverage(withReel(r), target) >= 1; })
                .reduce(function (best, r) { return leaner(r, best) < 0 ? r : best; });
            }
            pool.splice(pool.indexOf(next), 1);
            used[next.id] = true;
            got.kg += usefulKg(next, d);
            got.mtrs += next.mtrs || 0;
            picked.push(next);
          }
          return {
            width: d.width, webs: d.webs || 0, need: d, target: target,
            got: { kg: round2(got.kg), mtrs: round2(got.mtrs) },
            picked: picked,
            covered: coverage({ kg: got.kg, mtrs: got.mtrs }, d),
            // Reels that fit this web and were still on the shelf afterwards.
            spare: cands.length - picked.length,
          };
        });
      });
    }

    // ---- pass 1: what each WIDTH can manage if nothing is held back ---------
    var full = allocate(function () { return 1; });
    var byWidth = {};
    var widthOrder = [];
    // A layer whose material has no width of its own -- adhesive, which comes
    // in drums and coats whatever is running -- states ONE demand for the
    // whole job instead of one per web. Splitting it per width would round a
    // part-drum up three times over and lock drums the job never needed. What
    // it covers caps every web equally, since a deckle of any width still
    // needs glue.
    var whole = { fraction: 1, labels: [] };
    layers.forEach(function (L, li) {
      // A layer with nothing pickable AT ALL (no adhesive binding set, nothing
      // of that spec in this store) is left out of the width arithmetic. It
      // cannot say how far a web can run, and letting its zero through would
      // scale every other layer to nothing and tick no reels anywhere -- which
      // tells the planner less than ticking what IS there and naming the
      // blocker. It comes back as `blocked`, and `runMtrs` still goes to zero
      // for it below: the job genuinely cannot be laminated.
      //
      // A layer that HAS stock but none wide enough for one particular web is
      // a different thing entirely, and does cap that web at what it can do --
      // that is the whole point of working per width.
      if (!L.reels.length) return;
      full[li].forEach(function (a) {
        if (a.width == null) {
          if (a.covered < whole.fraction - 1e-9) { whole.fraction = Math.min(1, a.covered); whole.labels = [L.label]; }
          else if (Math.abs(a.covered - whole.fraction) < 1e-9 && a.covered < 0.9999
                   && whole.labels.indexOf(L.label) === -1) { whole.labels.push(L.label); }
          return;
        }
        var k = widthKey(a.width);
        if (!byWidth[k]) {
          byWidth[k] = { width: a.width, webs: a.webs, mtrs: a.need.mtrs || 0, fraction: 1, limitLabels: [] };
          widthOrder.push(byWidth[k]);
        }
        var W = byWidth[k];
        W.mtrs = Math.max(W.mtrs, a.need.mtrs || 0);
        if (a.covered < W.fraction - 1e-9) { W.fraction = Math.min(1, a.covered); W.limitLabels = [L.label]; }
        else if (Math.abs(a.covered - W.fraction) < 1e-9 && a.covered < 0.9999
                 && W.limitLabels.indexOf(L.label) === -1) { W.limitLabels.push(L.label); }
      });
    });
    // The whole-job cap applies to every web.
    if (whole.fraction < 0.9999) {
      widthOrder.forEach(function (W) {
        if (whole.fraction < W.fraction - 1e-9) { W.fraction = whole.fraction; W.limitLabels = whole.labels.slice(); }
        else if (Math.abs(whole.fraction - W.fraction) < 1e-9) {
          whole.labels.forEach(function (l) { if (W.limitLabels.indexOf(l) === -1) W.limitLabels.push(l); });
        }
      });
    }
    // Every layer empty (or none at all) -- there are no widths to report on,
    // so seed them from the demands so the totals below still stand up.
    if (!widthOrder.length) {
      (layers[0] ? layers[0].demands : []).forEach(function (d) {
        var W = { width: d.width, webs: d.webs || 0, mtrs: d.mtrs || 0, fraction: 0, limitLabels: [] };
        byWidth[widthKey(d.width)] = W;
        widthOrder.push(W);
      });
    }

    // ---- pass 2: allot to what can be run -----------------------------------
    // A whole-job demand (a drum) is aimed at the share of the batch that can
    // actually be laminated -- the metres-weighted average of the webs, not
    // the worst of them: glue for the webs that CAN run is still needed.
    var runnableShare = (function () {
      var tot = widthOrder.reduce(function (a, W) { return a + W.mtrs; }, 0);
      if (!(tot > 0)) return widthOrder.length ? widthOrder[0].fraction : 1;
      return widthOrder.reduce(function (a, W) { return a + W.mtrs * Math.min(1, W.fraction); }, 0) / tot;
    })();
    var fractionFor = balance
      ? function (d) {
        if (d.width == null) return runnableShare;
        var W = byWidth[widthKey(d.width)];
        return W ? W.fraction : 1;
      }
      : function () { return 1; };
    var chosen = balance
      && (widthOrder.some(function (W) { return W.fraction < 0.9999; }) || whole.fraction < 0.9999)
      ? allocate(fractionFor)
      : full;

    layers.forEach(function (L, li) {
      var alloc = chosen[li];
      L.byWidth = alloc;
      L.picked = alloc.reduce(function (a, x) { return a.concat(x.picked); }, []);
      L.got = alloc.reduce(function (a, x) {
        return { kg: round2(a.kg + x.got.kg), mtrs: round2(a.mtrs + x.got.mtrs) };
      }, { kg: 0, mtrs: 0 });
      // The WORST width, not the average: a layer that cannot serve one of the
      // batch's widths is not "nearly covered" just because the others are.
      L.covered = alloc.reduce(function (m, x) { return Math.min(m, x.covered); }, 1);
      L.blocked = L.picked.length === 0;
      // Widths this layer could not fully serve even at full allotment, and
      // the ones it simply has no reel wide enough for -- the two things a
      // planner has to be told, and neither is visible in a total.
      L.shortWidths = full[li].filter(function (x) { return x.covered < 0.9999; })
        .map(function (x) { return { width: x.width, webs: x.webs, covered: x.covered, none: x.picked.length === 0 }; });
      var fullCount = full[li].reduce(function (n, x) { return n + x.picked.length; }, 0);
      L.heldBackReels = Math.max(0, fullCount - L.picked.length);
      L.heldBackMtrs = round2(Math.max(0,
        full[li].reduce(function (n, x) { return n + x.got.mtrs; }, 0) - L.got.mtrs));
      L.leftOver = L.reels.length - L.picked.length;
    });

    // What can actually be laminated: each width runs as far as its own
    // shortest layer allows, and the job is the sum of those -- not one
    // fraction of the batch, because a shortage at one width leaves the others
    // perfectly runnable.
    var jobNeedMtrs = widthOrder.reduce(function (a, W) { return a + W.mtrs; }, 0);
    // ...and nothing at all runs while a layer has no reel on it: a deckle is
    // every layer at once, so one missing material stops the whole batch
    // however well the others are covered.
    var anyBlocked = layers.some(function (L) { return L.blocked; });
    var runMtrs = anyBlocked ? 0
      : widthOrder.reduce(function (a, W) { return a + W.mtrs * Math.min(1, W.fraction); }, 0);
    var limitWidths = widthOrder.filter(function (W) { return W.fraction < 0.9999; });

    return {
      balance: balance,
      layers: layers,
      widths: widthOrder,
      limitWidths: limitWidths,
      // The tightest width, for the headline. Null when nothing is short.
      limitFraction: widthOrder.length
        ? widthOrder.reduce(function (m, W) { return Math.min(m, W.fraction); }, 1) : 1,
      jobNeedMtrs: round2(jobNeedMtrs),
      runMtrs: round2(runMtrs),
      totalReels: layers.reduce(function (n, L) { return n + L.picked.length; }, 0),
      blockedLayers: layers.filter(function (L) { return L.blocked; }),
      // Short means "could not do better", not merely "below the order". A
      // layer matched down to what its widths can run is also below the order,
      // but deliberately and with reels left free -- calling that short would
      // put the blame on the wrong material and send someone off to buy paper
      // that is already on the shelf. Those are `heldBackLayers` instead.
      shortLayers: layers.filter(function (L) {
        return !L.blocked && L.shortWidths.length > 0;
      }),
      heldBackLayers: layers.filter(function (L) { return L.heldBackReels > 0; }),
    };
  }

  root.planRawAllotment = planRawAllotment;
  root.rawAllotCoverage = coverage;
})(typeof window !== "undefined" ? window : globalThis);
