// The two lengths a deckle job is described by, kept in one place because four
// pages show them and they used to disagree.
//
//   Running Mtrs        `deckleRunningMeters` -- the length of ONE deckle web.
//   Total Running Mtrs  that web's length x how many webs are laminated.
//
// `PendingProduction.runningMeters` is NOT a safe source for the second one on
// a batch. Batch creation used to fill it by summing the member orders' own
// `runningMeters`, but that field is the length of ONE FINISHED ROLL -- the
// same 1,000 m on every order -- so the sum counted orders rather than metres:
// four 1,000 m orders stored "4,000" against a thirteen-web deckle, and the
// same job split into eight orders would have stored 8,000. Deriving it here
// instead means the batches already saved with that number read correctly
// without a migration.
//
// On a plain (non-batch) order `runningMeters` is the per-roll length and means
// exactly what it says -- nothing here touches that.

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n) => Math.round(n * 100) / 100;

// Total metres of web this job laminates. Falls back to whatever was stored
// when there is no per-web length or web count to multiply -- an order from
// before Deckle Set took those two numbers separately.
export function deckleTotalRunningMetres(pp) {
  const webLen = num(pp?.deckleRunningMeters);
  const webs = num(pp?.noOfRolls);
  if (webLen > 0 && webs > 0) return round2(webLen * webs);
  return num(pp?.runningMeters);
}

// "1,000 M/DECKLE · 13,000 M TOTAL" -- the one-line form the machine job card
// and the Deckle Queue show in place of the bare number. Null when there is no
// per-web length, which is what the callers key "show the plain number" off.
export function deckleRunningMetersText(pp) {
  const webLen = num(pp?.deckleRunningMeters);
  if (!(webLen > 0)) return null;
  const total = deckleTotalRunningMetres(pp);
  if (!(total > 0)) return null;
  return `${webLen.toLocaleString("en-IN")} M/DECKLE · ${total.toLocaleString("en-IN")} M TOTAL`;
}
