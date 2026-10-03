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

export const LAMINATOR_SPEED_MPM = 15;

const MS_PER_MIN = 60 * 1000;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
//                 deckle came off.
//
// Times are returned as epoch ms. Whether a run is overdue is left to the
// page, which knows what time it is when it draws the row.
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

  const run = progress?.currentRun || null;
  const startedAtMs = run?.startedAt ? new Date(run.startedAt).getTime() : NaN;
  const current = run && Number.isFinite(startedAtMs)
    ? {
        index: done + 1,
        startedAt: startedAtMs,
        startTime: run.startTime || "",
        startMtrs: run.startMtrs ?? null,
        mtrs: deckleMtrs,
        etaAt: minsPerDeckle != null ? Math.round(startedAtMs + minsPerDeckle * MS_PER_MIN) : null,
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

  // Where the job is, one word for the Live column. A deckle on the machine
  // outranks everything; then a Job Setting row; then, with nothing running:
  // every planned deckle made, between two deckles (one has come off), or
  // played with nothing made yet.
  const ms = (v) => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const settingAt = current ? null : ms(progress?.setting?.startedAt);
  const setting = settingAt != null
    ? { startedAt: settingAt, startTime: progress.setting.startTime || "", startMtrs: progress.setting.startMtrs ?? null }
    : null;
  const lastDoneAt = ms(progress?.lastDoneAt);
  const phase = current ? "running"
    : setting ? "setting"
    : target > 0 && toMake === 0 ? "made"
    : done > 0 ? "gap"
    : "started";
  // The idle stretch between one deckle's Stop and the next one's Start: the
  // one in progress (phase "gap", counted up to now by the page), or the one
  // that came before the deckle running now. Both ends are server clocks --
  // the Deckle's createdAt (its Stop) and liveRun.startedAt (the Start).
  const gapSince = phase === "gap" ? lastDoneAt : null;
  const gapBeforeMins = current && lastDoneAt != null && current.startedAt > lastDoneAt
    ? (current.startedAt - lastDoneAt) / 60000
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
  const recordedStart = ms(progress?.jobStartedAt);
  const firstStop = (Array.isArray(progress?.production) ? progress.production : [])
    .filter((row) => row?.live)
    .map((row) => ms(row.producedAt))
    .filter((t) => t != null)
    .reduce((min, t) => (min == null || t < min ? t : min), null);
  const startInferred = firstStop != null && (recordedStart == null || firstStop < recordedStart);
  const jobStartedAt = startInferred
    ? Math.round(firstStop - (minsPerDeckle || 0) * MS_PER_MIN)
    : recordedStart;
  const priorDone = Math.max(Number(pp?.producedRolls) || 0, 0);
  const targetDeckles = target != null ? Math.max(target - priorDone, 0) : null;
  const targetAt = jobStartedAt != null && targetDeckles != null && minsPerDeckle != null
    ? Math.round(jobStartedAt + targetDeckles * minsPerDeckle * MS_PER_MIN)
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
    setting,
    jobStartedAt,
    startInferred,
    lastDoneAt,
    gapSince,
    gapBeforeMins,
    priorDone,
    targetDeckles,
    targetAt,
  };
}
