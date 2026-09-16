// Invariant check for public/js/rawAutoAllot.js -- the planner behind Assign
// Production's "Auto Allot (FIFO)" button. No DB, no browser; exits non-zero
// on failure, same contract as scripts/deckle-optimizer-bench.js.
//
//   node scripts/raw-auto-allot-bench.js [--verbose]
//
// The planner is a browser file (it is served to the page as /js/rawAutoAllot.js),
// so it is loaded here into a vm context with a stand-in `window` rather than
// imported -- which also proves it carries no dependency on the DOM.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "public", "js", "rawAutoAllot.js"), "utf8");
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "rawAutoAllot.js" });
const { planRawAllotment } = sandbox;

const VERBOSE = process.argv.includes("--verbose");
let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    if (VERBOSE) console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
}

const day = (s) => Date.parse(`${s}T00:00:00Z`);
// A reel as the page hands it over: already measured (kg, and the metres that
// weight gives at its own width), carrying its width -- null for a drum.
const reel = (rollId, kg, mtrs, date, width = null) =>
  ({ id: rollId, rollId, kg, mtrs, time: day(date), width });
// One web width's share of a layer's requirement.
const demand = (width, webs, kg, mtrs) => ({ width, webs, kg, mtrs });
const ids = (list) => list.map((r) => r.rollId).join(",");

function run(title, fn) {
  console.log(title);
  fn();
}

// ---------------------------------------------------------------------------
run("FIFO: oldest reel first, and only as many as the web needs", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 2, 100, 1000)],
      reels: [
        reel("NEW", 60, 600, "2026-08-01", 660),
        reel("OLD", 60, 600, "2026-01-01", 660),
        reel("MID", 60, 600, "2026-05-01", 660),
      ],
    }],
  });
  const L = plan.layers[0];
  check("oldest first", ids(L.picked).startsWith("OLD"), ids(L.picked));
  check("then next oldest", L.picked[1].rollId === "MID", ids(L.picked));
  check("stops once covered", L.picked.length === 2, `picked ${L.picked.length}`);
  check("one reel left on the shelf", L.leftOver === 1, String(L.leftOver));
  check("reports covered", L.covered >= 1, String(L.covered));
  check("nothing short", plan.shortLayers.length === 0);
  check("whole job runnable", plan.runMtrs === plan.jobNeedMtrs, `${plan.runMtrs}/${plan.jobNeedMtrs}`);
});

run("Width: an exact-fit reel is taken before an older wider one", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 1, 50, 500)],
      reels: [
        reel("WIDE-OLD", 100, 1000, "2020-01-01", 1020),
        reel("EXACT-NEW", 100, 1000, "2026-01-01", 660),
      ],
    }],
  });
  check("exact fit wins over age", plan.layers[0].picked[0].rollId === "EXACT-NEW",
    ids(plan.layers[0].picked));
});

run("A wider reel only counts the weight that lands on the web", () => {
  // 1020 mm reel, 100 kg, run for a 510 mm web: half of it is edge trim, so it
  // covers 50 kg of the requirement, not 100.
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(510, 1, 100, 500)],
      reels: [reel("WIDE", 100, 500, "2026-01-01", 1020)],
    }],
  });
  check("only the useful half counts", Math.abs(plan.layers[0].got.kg - 50) < 0.01,
    String(plan.layers[0].got.kg));
  check("so the web is not covered", plan.layers[0].covered < 1, String(plan.layers[0].covered));
});

run("Both sides count: enough kg but not enough metres is still short", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 1, 100, 1000)],
      reels: [reel("HEAVY-SHORT", 200, 400, "2026-01-01", 660)],
    }],
  });
  check("kg alone does not cover it", plan.layers[0].covered < 1, String(plan.layers[0].covered));
  check("coverage is the metres side", Math.abs(plan.layers[0].covered - 0.4) < 1e-9,
    String(plan.layers[0].covered));
  check("counted as short, not blocked", plan.shortLayers.length === 1 && plan.blockedLayers.length === 0);
});

// The case the button was asked for: plenty of facestock and adhesive, only
// part of the release liner. The job is the shortest material, so the other
// two are allotted to THAT, not to the order.
run("Balance: every layer matched to the shortest one", () => {
  // Facestock: 400 m reels, 1500 m wanted -> 4 reels for the order, 3 for the
  // 1000 m the liner actually allows. Adhesive: 500 m drums -> 3 vs 2.
  const layers = () => [
    { key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 3, 100, 1500)],
      reels: [reel("F1", 27, 400, "2026-01-01", 660), reel("F2", 27, 400, "2026-02-01", 660),
              reel("F3", 27, 400, "2026-03-01", 660), reel("F4", 27, 400, "2026-04-01", 660),
              reel("F5", 27, 400, "2026-05-01", 660)] },
    { key: "adhesive", pool: "adhesive", label: "Adhesive",
      demands: [demand(660, 3, 60, 1500)],
      reels: [reel("A1", 20, 500, "2026-01-01"), reel("A2", 20, 500, "2026-02-01"),
              reel("A3", 20, 500, "2026-03-01")] },
    { key: "releaseLiner", pool: "release", label: "Release Liner",
      demands: [demand(660, 3, 90, 1500)],
      reels: [reel("R1", 60, 1000, "2026-01-01", 660)] },
  ];

  const on = planRawAllotment({ layers: layers(), balance: true });
  check("the liner is what limits the web", on.limitWidths.length === 1
    && on.limitWidths[0].limitLabels.join() === "Release Liner",
    JSON.stringify(on.limitWidths.map((W) => W.limitLabels)));
  check("limit fraction is 2/3", Math.abs(on.limitFraction - 2 / 3) < 1e-9, String(on.limitFraction));
  check("can run 1000 of 1500", on.runMtrs === 1000 && on.jobNeedMtrs === 1500,
    `${on.runMtrs} / ${on.jobNeedMtrs}`);
  const face = on.layers[0];
  check("facestock took 3 reels, not 4", face.picked.length === 3, String(face.picked.length));
  check("facestock took the three oldest", ids(face.picked) === "F1,F2,F3", ids(face.picked));
  check("facestock reports one reel held back", face.heldBackReels === 1, String(face.heldBackReels));
  check("held-back metres are stated", face.heldBackMtrs === 400, String(face.heldBackMtrs));
  const ad = on.layers[1];
  check("adhesive took 2 drums, not 3", ad.picked.length === 2, String(ad.picked.length));
  check("adhesive reports one drum held back", ad.heldBackReels === 1, String(ad.heldBackReels));
  check("the liner itself is not 'held back'", on.layers[2].heldBackReels === 0);
  check("the liner is the one reported short", on.shortLayers.length === 1
    && on.shortLayers[0].key === "releaseLiner", on.shortLayers.map((L) => L.key).join());
  check("no layer reported as blocked", on.blockedLayers.length === 0);
  check("two layers held back in all", on.heldBackLayers.length === 2, String(on.heldBackLayers.length));

  const off = planRawAllotment({ layers: layers(), balance: false });
  check("balance off: facestock takes the full 1500+", off.layers[0].got.mtrs >= 1500,
    String(off.layers[0].got.mtrs));
  check("balance off: the job still can only run 1000", off.runMtrs === 1000, String(off.runMtrs));
  check("balance off locks more material", off.totalReels > on.totalReels,
    `${off.totalReels} vs ${on.totalReels}`);
  check("balance off claims nothing was held back", off.heldBackLayers.length === 0);
});

// ---------------------------------------------------------------------------
// Mixed webs -- the trap this planner exists for. A batch of 660 x 2 + 635 x 3
// + 510 x 1 is not one requirement: a 510 mm reel cannot make a 660 mm deckle,
// and oldest-first over one flat list would hand it the whole job.
run("Mixed webs: a narrow reel is only used for the webs it fits", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 2, 106, 2000), demand(635, 3, 152, 3000), demand(510, 1, 41, 1000)],
      reels: [
        // The oldest reels on the shelf are the narrow ones -- exactly the
        // pull that a width-blind FIFO gets wrong.
        reel("N1", 60, 1000, "2020-01-01", 510), reel("N2", 60, 1000, "2020-01-02", 510),
        reel("M1", 80, 1000, "2024-01-01", 635), reel("M2", 80, 1000, "2024-01-02", 635),
        reel("M3", 80, 1000, "2024-01-03", 635), reel("M4", 80, 1000, "2024-01-04", 635),
        reel("W1", 90, 1000, "2026-01-01", 660), reel("W2", 90, 1000, "2026-01-02", 660),
        reel("W3", 90, 1000, "2026-01-03", 660),
      ],
    }],
  });
  const L = plan.layers[0];
  const at = (w) => L.byWidth.find((x) => x.width === w);
  check("the 660 webs got 660 reels", at(660).picked.every((r) => r.width >= 660), ids(at(660).picked));
  check("the 660 webs are covered", at(660).covered >= 1, String(at(660).covered));
  check("the 635 webs got 635 reels", ids(at(635).picked) === "M1,M2,M3", ids(at(635).picked));
  check("the 510 web got the oldest 510 reel", ids(at(510).picked) === "N1", ids(at(510).picked));
  check("no reel is used twice",
    new Set(L.picked.map((r) => r.rollId)).size === L.picked.length, ids(L.picked));
  check("the whole batch is runnable", plan.runMtrs === plan.jobNeedMtrs,
    `${plan.runMtrs}/${plan.jobNeedMtrs}`);
  check("nothing reported short", plan.shortLayers.length === 0,
    JSON.stringify(plan.shortLayers.map((x) => x.label)));
});

run("Mixed webs: only the width that is short is cut back", () => {
  // Nothing wide enough for the two 660 mm webs; the 635s and the 510 are fine.
  const plan = planRawAllotment({
    layers: [
      { key: "facestock", pool: "facestock", label: "Facestock",
        demands: [demand(660, 2, 106, 2000), demand(635, 3, 152, 3000), demand(510, 1, 41, 1000)],
        reels: [
          reel("M1", 80, 1000, "2024-01-01", 635), reel("M2", 80, 1000, "2024-01-02", 635),
          reel("M3", 80, 1000, "2024-01-03", 635), reel("N1", 60, 1000, "2020-01-01", 510),
        ] },
      { key: "releaseLiner", pool: "release", label: "Release Liner",
        demands: [demand(660, 2, 89, 2000), demand(635, 3, 128, 3000), demand(510, 1, 34, 1000)],
        reels: [
          reel("R660a", 90, 1000, "2026-01-01", 660), reel("R660b", 90, 1000, "2026-01-02", 660),
          reel("R635a", 70, 1000, "2026-01-03", 635), reel("R635b", 70, 1000, "2026-01-04", 635),
          reel("R635c", 70, 1000, "2026-01-05", 635), reel("R510", 40, 1000, "2026-01-06", 510),
        ] },
    ],
    balance: true,
  });
  const width = (w) => plan.widths.find((W) => W.width === w);
  check("the 660 webs cannot run", width(660).fraction === 0, String(width(660).fraction));
  check("the 635 webs still can", width(635).fraction >= 1, String(width(635).fraction));
  check("the 510 web still can", width(510).fraction >= 1, String(width(510).fraction));
  check("the job runs everything but the 660s", plan.runMtrs === 4000,
    `${plan.runMtrs} of ${plan.jobNeedMtrs}`);
  check("facestock is named as the limit on 660", width(660).limitLabels.join() === "Facestock",
    width(660).limitLabels.join());
  check("the liner was not allotted reels for the dead 660 webs",
    plan.layers[1].byWidth.find((x) => x.width === 660).picked.length === 0,
    ids(plan.layers[1].byWidth.find((x) => x.width === 660).picked));
  check("the liner reports those reels held back", plan.layers[1].heldBackReels === 2,
    String(plan.layers[1].heldBackReels));
  check("facestock is short at 660 only", plan.layers[0].shortWidths.length === 1
    && plan.layers[0].shortWidths[0].width === 660 && plan.layers[0].shortWidths[0].none === true,
    JSON.stringify(plan.layers[0].shortWidths));
});

run("A layer with nothing pickable blocks the job without zeroing the others", () => {
  const plan = planRawAllotment({
    layers: [
      { key: "facestock", pool: "facestock", label: "Facestock",
        demands: [demand(660, 1, 100, 1000)], reels: [reel("F1", 100, 1000, "2026-01-01", 660)] },
      { key: "adhesive", pool: "adhesive", label: "Adhesive",
        demands: [demand(660, 1, 60, 1000)], reels: [], skipped: [] },
    ],
    balance: true,
  });
  check("the empty layer is blocked", plan.blockedLayers.length === 1
    && plan.blockedLayers[0].key === "adhesive");
  check("the job cannot run at all", plan.runMtrs === 0, String(plan.runMtrs));
  // The empty layer is left out of the width arithmetic rather than scaling
  // everything to zero: the facestock that IS there is still ticked, so the
  // order lands on the queue short-allotted (which the server supports) with
  // the blocker named, instead of the button doing nothing and saying little.
  check("the facestock that is there is still ticked", plan.layers[0].picked.length === 1,
    String(plan.layers[0].picked.length));
  check("facestock is not itself blocked", plan.layers[0].blocked === false);
});

run("Two layers on one pool compete for the same reels", () => {
  const plan = planRawAllotment({
    layers: [
      { key: "facestock", pool: "facestock", label: "Facestock",
        demands: [demand(660, 1, 50, 500)],
        reels: [reel("F1", 50, 500, "2026-01-01", 660), reel("F2", 50, 500, "2026-02-01", 660)] },
      { key: "facestock2", pool: "facestock", label: "Facestock (Layer 2)",
        demands: [demand(660, 1, 50, 500)],
        reels: [reel("F1", 50, 500, "2026-01-01", 660), reel("F2", 50, 500, "2026-02-01", 660)] },
    ],
    balance: true,
  });
  const a = ids(plan.layers[0].picked);
  const b = ids(plan.layers[1].picked);
  check("no reel is allotted to both layers", a !== b && !a.split(",").some((x) => b.split(",").includes(x)),
    `${a} / ${b}`);
  check("layer 1 takes the older", a === "F1", a);
  check("layer 2 takes the other", b === "F2", b);
});

run("A layer with no weighable requirement is planned on length alone", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(660, 1, null, 1000)],          // microns, not GSM -- cannot be weighed
      reels: [reel("F1", 0, 600, "2026-01-01", 660), reel("F2", 0, 600, "2026-02-01", 660)],
    }],
  });
  check("still picks against the metres", plan.layers[0].picked.length === 2,
    String(plan.layers[0].picked.length));
  check("and reports it covered", plan.layers[0].covered >= 1, String(plan.layers[0].covered));
});

run("Stable: the same input picks the same reels twice running", () => {
  const input = () => ({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock", demands: [demand(660, 1, 10, 100)],
      reels: [reel("B", 10, 100, "2026-01-01", 660), reel("A", 10, 100, "2026-01-01", 660),
              reel("C", 10, 100, "2026-01-01", 660)],
    }],
  });
  const one = ids(planRawAllotment(input()).layers[0].picked);
  const two = ids(planRawAllotment(input()).layers[0].picked);
  check("same pick both times", one === two, `${one} vs ${two}`);
  check("ties break on Roll ID", one === "A", one);
});

// The defect this rule exists for, from a real 635 mm batch: the liner capped
// the job at 125 kg of facestock, FIFO took the 102 kg remnant, landed 23 kg
// short, and reached for a 630 kg reel -- 732 kg locked for a 125 kg job with
// a 27 kg remnant of the same paper still on the shelf.
run("The last reel is the leanest that finishes, not the next by date", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(635, 15, 125, 2468)],
      reels: [
        reel("REMNANT-102", 102, 2007, "2026-06-10", 635),
        reel("FULL-630", 630, 12401, "2026-06-11", 635),
        reel("REMNANT-27", 27, 531, "2026-07-17", 635),
        reel("FULL-630-B", 630, 12401, "2026-07-18", 635),
      ],
    }],
  });
  const L = plan.layers[0];
  check("oldest remnant still goes first", L.picked[0].rollId === "REMNANT-102", ids(L.picked));
  check("the gap is closed by the lean reel, not the next by date",
    ids(L.picked) === "REMNANT-102,REMNANT-27", ids(L.picked));
  check("covered", L.covered >= 1, String(L.covered));
  check("129 kg locked, not 732", Math.abs(L.got.kg - 129) < 0.01, String(L.got.kg));
});

run("One reel that can finish is not preferred over using up old stock first", () => {
  // Nothing can finish it alone, so FIFO runs the whole way -- the lean rule
  // must not fire early and skip the old reels.
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock",
      demands: [demand(635, 1, 300, 3000)],
      reels: [
        reel("OLD-A", 100, 1000, "2026-01-01", 635),
        reel("OLD-B", 100, 1000, "2026-02-01", 635),
        reel("NEW-BIG", 120, 1200, "2026-09-01", 635),
      ],
    }],
  });
  check("old stock moves first", ids(plan.layers[0].picked) === "OLD-A,OLD-B,NEW-BIG",
    ids(plan.layers[0].picked));
});

run("Never over-allots: one fewer reel would not have covered it", () => {
  const plan = planRawAllotment({
    layers: [{
      key: "facestock", pool: "facestock", label: "Facestock", demands: [demand(660, 1, 100, 1000)],
      reels: Array.from({ length: 20 }, (_, i) =>
        reel(`F${String(i).padStart(2, "0")}`, 30, 300, `2026-01-${String(i + 1).padStart(2, "0")}`, 660)),
    }],
  });
  const picked = plan.layers[0].picked;
  const withoutLast = picked.slice(0, -1).reduce((a, r) => a + r.mtrs, 0);
  check("covered", plan.layers[0].got.mtrs >= 1000, String(plan.layers[0].got.mtrs));
  check("one fewer reel would not have covered it", withoutLast < 1000, String(withoutLast));
});

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All raw-material Auto Allot checks passed.");
