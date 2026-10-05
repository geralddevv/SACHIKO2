// How long a lamination job still has to run, and when it should get there --
// the WIP tab's Live and Target columns (GET /labels/production/pending?tab=wip).
//
// Plain numbers in, plain numbers out: no mongoose, no express. The caller
// hands in the PendingProduction doc and what buildJobCardProgressMap
// (routes/fairdesk_route.js) found on the shop floor.
//
// The arithmetic is deliberately the simple one the floor works to: the
// laminator runs at LAMINATOR_SPEED_MPM, so a deckle web of L metres takes
// L / speed minutes from the moment its Start is punched. Stops between
// deckles (a reel change, a joint) are not modelled -- the job ETA is "if it
// keeps running", which is why every figure on the page is marked approx.
//
// The one stop that IS modelled is a hold: the operator tapping Pause in the
// app (PendingProduction.livePause / livePauseLog). Time on hold is not the
// machine running slow or standing idle, so it is taken out of every clock
// here -- a deckle's ETA, a setting or idle stretch, the job's Target -- and
// while the job is on hold right now the page stops its own clock at the
// moment it went on hold (`clockAt`), so nothing moves until it resumes.

export const LAMINATOR_SPEED_MPM = 15;

const MS_PER_MIN = 60 * 1000;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toMs = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

// How long, in ms, the job spent on hold between `from` and `to`, off the
// holds it has come out of. The hold it is on now is not counted here: while
// it lasts the page's clock stands still at its start instead.
const heldWithin = (pauses, from, to = Infinity) => pauses.reduce((sum, p) => {
  const a = Math.max(p.from, from);
  const b = Math.min(p.to, to);
  return b > a ? sum + (b - a) : sum;
}, 0);

// How many deckles this job lays down -- one per Production Log row. A plain
// order's Qty, a deckle batch's planner-entered Deckle Qty (stored as
// noOfRolls). A plain order's own noOfRolls is the sales order's finished-roll
// count for slitting, never the machine's target. The machine queue
// (buildQueueRows in routes/system/machine.js) reads it through here too, so
// the two pages can't disagree about how many deckles a job is.
export function deckleTargetOf(pp) {
  if (pp?.isDeckleBatch) return pp?.noOfRolls != null ? Number(pp.noOfRolls) : null;
  return pp?.quantity != null ? Number(pp.quantity) : null;
}

// Length of ONE deckle web, in metres -- what each Production Log row runs.
//   1. `deckleRunningMeters`, set on Deckle Set;
//   2. else the first layout's own Deckle R.M. (how Deckle Set fills (1));
//   3. else, on a plain order only, `runningMeters`: there it is the length of
//      the one roll each unit of Qty is, and Qty is the deckle count.
// On a batch `runningMeters` is NOT a web length (see utils/deckleTotals.js),
// so a batch with neither (1) nor (2) has no length and gets no ETA rather
// than a made-up one.
export function deckleWebLength(pp) {
  const drm = num(pp?.deckleRunningMeters);
  if (drm > 0) return drm;
  const layout = (Array.isArray(pp?.deckleLayout) ? pp.deckleLayout : [])
    .find((L) => num(L?.deckleRunningMeter) > 0);
  if (layout) return num(layout.deckleRunningMeter);
  if (!pp?.isDeckleBatch) {
    const rm = num(pp?.runningMeters);
    if (rm > 0) return rm;
  }
  return null;
}

// `progress` is the order's entry from buildJobCardProgressMap (or null):
//   production -- every deckle made so far, card rows and live Deckles,
//                 de-duplicated, so its length IS the count made;
//   currentRun -- { startedAt, startTime, startMtrs } of the row running now;
//   setting    -- the same, of the Job Setting row running now;
//   jobStartedAt / lastDoneAt -- when the job was played, when its last
//                 deckle came off;
//   paused     -- { since, reason, deviceLabel } of the hold it is on now;
//   pauses     -- [{ from, to }] of the holds it has come out of.
//
// Times are returned as epoch ms. Whether a run is overdue is left to the
// page, which knows what time it is when it draws the row -- or, for a job on
// hold, uses `clockAt` (the moment it went on hold) in place of now.
export function buildRunPlan(pp, progress, speedMpm = LAMINATOR_SPEED_MPM) {
  const deckleMtrs = deckleWebLength(pp);
  const minsPerDeckle = deckleMtrs > 0 && speedMpm > 0 ? deckleMtrs / speedMpm : null;
  const target = deckleTargetOf(pp);
  // producedRolls is the count filed on saved cards; `production` adds the
  // Deckles made since. The larger of the two, so neither can under-count.
  const done = Math.max(
    Array.isArray(progress?.production) ? progress.production.length : 0,
    Number(pp?.producedRolls) || 0,
  );
  const toMake = target != null ? Math.max(target - done, 0) : null;

  const pauses = (Array.isArray(progress?.pauses) ? progress.pauses : [])
    .map((p) => ({ from: toMs(p?.from), to: toMs(p?.to), reason: p?.reason || "" }))
    .filter((p) => p.from != null && p.to != null && p.to > p.from);
  const pausedAt = toMs(progress?.paused?.since);
  const paused = pausedAt != null
    ? { since: pausedAt, reason: progress.paused.reason || "", deviceLabel: progress.paused.deviceLabel || "" }
    : null;

  // The deckle on the machine. Time it spent on hold moves its ETA on by as
  // much: `runFromAt` is its Start pushed forward by that time, which is where
  // the page counts its progress from.
  const run = progress?.currentRun || null;
  const startedAtMs = toMs(run?.startedAt);
  const runHeldMs = startedAtMs != null ? heldWithin(pauses, startedAtMs) : 0;
  const current = run && startedAtMs != null
    ? {
        index: done + 1,
        startedAt: startedAtMs,
        startTime: run.startTime || "",
        startMtrs: run.startMtrs ?? null,
        mtrs: deckleMtrs,
        heldMs: runHeldMs,
        runFromAt: startedAtMs + runHeldMs,
        etaAt: minsPerDeckle != null ? Math.round(startedAtMs + runHeldMs + minsPerDeckle * MS_PER_MIN) : null,
      }
    : null;

  // Deckles still to START once the running one is off -- the running one is
  // part of `toMake` until its Stop inwards it.
  const afterCurrent = toMake != null ? Math.max(toMake - (current ? 1 : 0), 0) : null;
  const jobEtaAt = current?.etaAt != null && afterCurrent != null
    ? Math.round(current.etaAt + afterCurrent * minsPerDeckle * MS_PER_MIN)
    : null;
  // With nothing running there is no clock to count from -- only how much
  // running is left.
  const remainingMins = !current && toMake != null && minsPerDeckle != null
    ? toMake * minsPerDeckle
    : null;

  // Where the job is, one word for the Live column. On hold outranks
  // everything -- the operator has said the job is stopped. Under that
  // (`basePhase`, what was going on when it stopped): a deckle on the
  // machine; then a Job Setting row; then, with nothing running: every
  // planned deckle made, between two deckles (one has come off), or played
  // with nothing made yet.
  const settingAt = current ? null : toMs(progress?.setting?.startedAt);
  const setting = settingAt != null
    ? {
        startedAt: settingAt,
        startTime: progress.setting.startTime || "",
        startMtrs: progress.setting.startMtrs ?? null,
        heldMs: heldWithin(pauses, settingAt),
      }
    : null;
  const lastDoneAt = toMs(progress?.lastDoneAt);
  const basePhase = current ? "running"
    : setting ? "setting"
    : target > 0 && toMake === 0 ? "made"
    : done > 0 ? "gap"
    : "started";
  const phase = paused ? "paused" : basePhase;
  // The idle stretch between one deckle's Stop and the next one's Start: the
  // one in progress (phase "gap", counted up to now by the page, less
  // `gapHeldMs` spent on hold), or the one that came before the deckle running
  // now. Both ends are server clocks -- the Deckle's createdAt (its Stop) and
  // liveRun.startedAt (the Start). A hold is not idle time, so it is taken out.
  const gapSince = basePhase === "gap" ? lastDoneAt : null;
  const gapHeldMs = gapSince != null ? heldWithin(pauses, gapSince) : 0;
  const gapBeforeMins = current && lastDoneAt != null && current.startedAt > lastDoneAt
    ? Math.max(current.startedAt - lastDoneAt - heldWithin(pauses, lastDoneAt, current.startedAt), 0) / 60000
    : null;

  // The WIP tab's Target: when this run of the job would be done had it run
  // nonstop at speed from the moment it was played -- no setting, no gaps, no
  // overrun. Fixed once the job starts, so it is what Status measures the
  // page's own Estimate against (that one is counted from now, so every delay
  // so far is in it).
  //
  // A job switched off mid-order (its card saved short of the target) is
  // played afresh on its next card: the save clears liveStartedAt and files
  // what was made as producedRolls. So the run being timed starts at
  // jobStartedAt and owes only what was not filed before it.
  //
  // The recorded start (liveStartedAt, else the app's running claim) can't be
  // later than a deckle this run already made: a job can't start after its
  // own deckle came off. That happens when the deckles predate the record --
  // made before liveStartedAt existed, or by an app build that never sent a
  // Start -- and a later punch then stamps "now" as the start, which would
  // have the Target time deckles made days ago as if they were still to run.
  // So a start that is missing, or later than this run's first deckle Stop,
  // is worked back from that Stop by one deckle's running time (as if it ran
  // at speed -- the Target's own assumption, so that deckle is neither early
  // nor late). Only unfiled ("live") Deckles count: filed rows belong to an
  // earlier card, i.e. an earlier run (see priorDone below).
  const recordedStart = toMs(progress?.jobStartedAt);
  const firstStop = (Array.isArray(progress?.production) ? progress.production : [])
    .filter((row) => row?.live)
    .map((row) => toMs(row.producedAt))
    .filter((t) => t != null)
    .reduce((min, t) => (min == null || t < min ? t : min), null);
  const startInferred = firstStop != null && (recordedStart == null || firstStop < recordedStart);
  const jobStartedAt = startInferred
    ? Math.round(firstStop - (minsPerDeckle || 0) * MS_PER_MIN)
    : recordedStart;
  const priorDone = Math.max(Number(pp?.producedRolls) || 0, 0);
  const targetDeckles = target != null ? Math.max(target - priorDone, 0) : null;
  // Every hold this run has come out of. The Target moves on by it: a job
  // paused for lunch is not 40 minutes late, it is 40 minutes on hold -- the
  // Live column and the dialog say so -- and Status measures the job against
  // the Target with that time taken out.
  const heldMs = jobStartedAt != null ? heldWithin(pauses, jobStartedAt) : heldWithin(pauses, -Infinity);
  const targetAt = jobStartedAt != null && targetDeckles != null && minsPerDeckle != null
    ? Math.round(jobStartedAt + targetDeckles * minsPerDeckle * MS_PER_MIN + heldMs)
    : null;

  return {
    speedMpm,
    deckleMtrs,
    minsPerDeckle,
    target,
    done,
    toMake,
    current,
    afterCurrent,
    jobEtaAt,
    remainingMins,
    phase,
    basePhase,
    setting,
    jobStartedAt,
    startInferred,
    lastDoneAt,
    gapSince,
    gapHeldMs,
    gapBeforeMins,
    priorDone,
    targetDeckles,
    targetAt,
    // On hold: the hold itself, and the time to read the job's clocks at
    // instead of now -- the moment it went on hold, so nothing moves until it
    // comes back. Null when it is running.
    paused,
    clockAt: paused ? paused.since : null,
    // The holds already over, for the dialog's log, and their total.
    pauses,
    heldMs,
  };
}

// The slitting machine's run speed, metres per minute -- the slitting WIP page's
// equivalent of LAMINATOR_SPEED_MPM. Env-overridable; defaults to the laminator
// pace, which is the value the shop chose for it.
export const SLITTING_SPEED_MPM = Number(process.env.SLITTING_SPEED_MPM) || 15;

// The slitting sibling of buildRunPlan: same output contract (so the Slitting
// WIP view reuses the lamination view's wipOutlook / wipSetLiveCell JS), but
// measured PER DECKLE rather than off one uniform deckle length -- each
// slittingLog row has its own plannedMeter, so a job ETA is the sum of the
// remaining rows' metres / speed, not a count x one deckle's time.
//
// `progress` is the card's entry from buildSlittingProgressMap
// (routes/system/slitting.js):
//   production  -- every Deckle run so far ({ producedAt, meters, ... }); its
//                  length IS the done count;
//   currentRun  -- { index, startedAt, startTime, startMtrs, mtrs } of the
//                  Deckle on the slitter now, mtrs = its planned metres;
//   setting     -- { startedAt, startTime, startMtrs } of the Job Setting row
//                  running now;
//   jobStartedAt / lastDoneAt -- when the card was played / its last Deckle came off;
//   target      -- how many Deckles this card cuts (slittingLog length);
//   totalPlannedMtrs        -- every Deckle's planned metres added up (the Target);
//   remainingMtrs           -- the not-done Deckles' planned metres (nothing running);
//   remainingMtrsAfterCurrent -- the same, minus the Deckle running now;
//   paused / pauses -- the hold it is on now, and the holds it has come out of.
//
// Times are epoch ms; whether a run is overdue is the page's call, exactly as
// with buildRunPlan. Where lamination exposes minsPerDeckle, this exposes
// minsPerMetre + the metre figures the view needs; it leaves minsPerDeckle null.
export function buildSlittingRunPlan(progress, speedMpm = SLITTING_SPEED_MPM) {
  const minsPerMetre = speedMpm > 0 ? 1 / speedMpm : null;
  const target = num(progress?.target);
  const totalPlannedMtrs = num(progress?.totalPlannedMtrs) || 0;
  const done = Array.isArray(progress?.production) ? progress.production.length : 0;
  const toMake = target != null ? Math.max(target - done, 0) : null;
  const hasRate = minsPerMetre != null && totalPlannedMtrs > 0;

  const pauses = (Array.isArray(progress?.pauses) ? progress.pauses : [])
    .map((p) => ({ from: toMs(p?.from), to: toMs(p?.to), reason: p?.reason || "" }))
    .filter((p) => p.from != null && p.to != null && p.to > p.from);
  const pausedAt = toMs(progress?.paused?.since);
  const paused = pausedAt != null
    ? { since: pausedAt, reason: progress.paused.reason || "", deviceLabel: progress.paused.deviceLabel || "" }
    : null;

  const minsFor = (mtrs) => (minsPerMetre != null && num(mtrs) != null ? num(mtrs) * minsPerMetre : null);

  // The Deckle on the slitter now. Time on hold pushes its ETA on by as much.
  const run = progress?.currentRun || null;
  const startedAtMs = toMs(run?.startedAt);
  const runHeldMs = startedAtMs != null ? heldWithin(pauses, startedAtMs) : 0;
  const curMtrs = run ? num(run.mtrs) : null;
  const curMins = minsFor(curMtrs);
  const current = run && startedAtMs != null
    ? {
        index: num(run.index) != null ? Number(run.index) : done + 1,
        startedAt: startedAtMs,
        startTime: run.startTime || "",
        startMtrs: run.startMtrs ?? null,
        mtrs: curMtrs,
        heldMs: runHeldMs,
        runFromAt: startedAtMs + runHeldMs,
        etaAt: curMins != null ? Math.round(startedAtMs + runHeldMs + curMins * MS_PER_MIN) : null,
      }
    : null;

  // Deckles still to START once the running one is off, and their metres.
  const afterCurrent = toMake != null ? Math.max(toMake - (current ? 1 : 0), 0) : null;
  const remainingMtrsAfterCurrent = num(progress?.remainingMtrsAfterCurrent) || 0;
  const remainingMtrs = num(progress?.remainingMtrs) || 0;
  const jobEtaAt = current?.etaAt != null && minsPerMetre != null
    ? Math.round(current.etaAt + remainingMtrsAfterCurrent * minsPerMetre * MS_PER_MIN)
    : null;
  const remainingMins = !current && minsPerMetre != null ? remainingMtrs * minsPerMetre : null;

  const settingAt = current ? null : toMs(progress?.setting?.startedAt);
  const setting = settingAt != null
    ? {
        startedAt: settingAt,
        startTime: progress.setting.startTime || "",
        startMtrs: progress.setting.startMtrs ?? null,
        heldMs: heldWithin(pauses, settingAt),
      }
    : null;
  const lastDoneAt = toMs(progress?.lastDoneAt);
  const basePhase = current ? "running"
    : setting ? "setting"
    : target > 0 && toMake === 0 ? "made"
    : done > 0 ? "gap"
    : "started";
  const phase = paused ? "paused" : basePhase;
  const gapSince = basePhase === "gap" ? lastDoneAt : null;
  const gapHeldMs = gapSince != null ? heldWithin(pauses, gapSince) : 0;
  const gapBeforeMins = current && lastDoneAt != null && current.startedAt > lastDoneAt
    ? Math.max(current.startedAt - lastDoneAt - heldWithin(pauses, lastDoneAt, current.startedAt), 0) / 60000
    : null;

  // The recorded start can't be later than a Deckle this run already made: work
  // it back from the first Deckle's Stop by that Deckle's own running time.
  // Unlike lamination there is no earlier card, so every produced row counts and
  // priorDone is 0 -- the Target is the whole card's metres.
  const recordedStart = toMs(progress?.jobStartedAt);
  const firstProduced = (Array.isArray(progress?.production) ? progress.production : [])
    .map((row) => ({ at: toMs(row?.producedAt), mtrs: num(row?.meters) }))
    .filter((row) => row.at != null)
    .reduce((min, row) => (min == null || row.at < min.at ? row : min), null);
  const firstStop = firstProduced ? firstProduced.at : null;
  const startInferred = firstStop != null && (recordedStart == null || firstStop < recordedStart);
  const jobStartedAt = startInferred
    ? Math.round(firstStop - (minsFor(firstProduced.mtrs) || 0) * MS_PER_MIN)
    : recordedStart;
  const targetDeckles = target;
  const heldMs = jobStartedAt != null ? heldWithin(pauses, jobStartedAt) : heldWithin(pauses, -Infinity);
  const targetMins = hasRate ? Math.round(totalPlannedMtrs * minsPerMetre) : null;
  const targetAt = jobStartedAt != null && hasRate
    ? Math.round(jobStartedAt + totalPlannedMtrs * minsPerMetre * MS_PER_MIN + heldMs)
    : null;

  return {
    speedMpm,
    // Slitting measures per metre, not per uniform deckle -- minsPerDeckle is
    // left null on purpose; the view reads minsPerMetre / targetMins instead.
    minsPerDeckle: null,
    minsPerMetre,
    hasRate,
    deckleMtrs: null,
    target,
    done,
    toMake,
    current,
    afterCurrent,
    remainingMtrsAfterCurrent,
    remainingMtrs,
    jobEtaAt,
    remainingMins,
    phase,
    basePhase,
    setting,
    jobStartedAt,
    startInferred,
    lastDoneAt,
    gapSince,
    gapHeldMs,
    gapBeforeMins,
    priorDone: 0,
    targetDeckles,
    totalPlannedMtrs,
    targetMins,
    targetAt,
    paused,
    clockAt: paused ? paused.since : null,
    pauses,
    heldMs,
  };
}
