import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import { getUserLocationNames, normalizeLocationName } from "./locations.js";

const BINDING_TYPES = [
  [Label, "label"],
  [TapeBinding, "tape"],
];

// A location rename commonly prepends/appends a town name onto what used to
// be just a plot code (e.g. "C-3" -> "PALGHAR C-3"). Match on a word
// boundary so "D-23" resolves to "BOISAR D-23" but not to an unrelated
// "D-235" — see scripts/fix-stale-binding-locations.js, which uses the same
// heuristic for one-off backfills of pre-existing bad data.
function renameCandidates(oldLoc, validLocs) {
  return validLocs.filter(
    (v) => v.endsWith(oldLoc) && (v.length === oldLoc.length || v[v.length - oldLoc.length - 1] === " "),
  );
}

// Resolves a stale location to exactly one of a user's current locations, or
// null if the target can't be determined without guessing: unambiguous when
// the user has only one location, or when exactly one current location is a
// word-boundary rename match for the stale value.
function resolveRenameTarget(oldLoc, validLocs) {
  if (validLocs.length === 1) return validLocs[0];
  const candidates = renameCandidates(oldLoc, validLocs);
  return candidates.length === 1 ? candidates[0] : null;
}

/*
 * Call after a user's locationDetails are saved (e.g. a location was renamed
 * or removed) to re-point any of their item bindings whose `location` no
 * longer matches any of the user's current locations — otherwise those
 * bindings silently disappear from every location-scoped view (see
 * scripts/fix-orphaned-item-locations.js, which this mirrors for one-off
 * backfills of pre-existing bad data).
 *
 * Auto-fixes when the correct target is unambiguous: either the user now has
 * exactly ONE location, or exactly one of the user's current locations is a
 * word-boundary rename match for the binding's stale value (see
 * resolveRenameTarget). Anything else gets reported back as `ambiguous`
 * instead of guessed at — the caller can surface that for manual review.
 */
export async function reconcileUserBindingLocations(userId) {
  const user = await Username.findById(userId)
    .select("locationDetails userLocation label colorLabel ttr tape")
    .populate(BINDING_TYPES.map(([, field]) => ({ path: field, select: "location" })))
    .lean();

  if (!user) return { fixed: [], ambiguous: [] };

  const validLocs = getUserLocationNames(user);
  const fixed = [];
  const ambiguous = [];

  for (const [Model, field] of BINDING_TYPES) {
    const items = user[field] || [];
    const ops = [];

    for (const item of items) {
      if (!item) continue;
      const itemLoc = normalizeLocationName(item.location);
      if (validLocs.includes(itemLoc)) continue; // already matches, nothing to do

      const target = resolveRenameTarget(itemLoc, validLocs);
      if (target) {
        ops.push({ updateOne: { filter: { _id: item._id }, update: { $set: { location: target } } } });
        fixed.push({ type: field, id: item._id, from: item.location, to: target });
      } else {
        ambiguous.push({ type: field, id: item._id, location: item.location, validLocs });
      }
    }

    if (ops.length) {
      await Model.collection.bulkWrite(ops, { ordered: false });
    }
  }

  return { fixed, ambiguous };
}

const IDENTITY_BINDING_TYPES = [
  [Label, "label"],
];

/*
 * Label/ColorLabel bindings (unlike Tape/TTR) don't reference
 * the owning user live via userId — they store their own denormalized copy
 * of clientName/userName/userContact, captured at binding-creation time. If
 * the user's name or contact is edited afterward, those bindings keep the
 * OLD values forever unless something re-syncs them — e.g. pages like
 * /labels/view/:id read straight off the binding, not the live Username doc.
 *
 * Call after a user's core identity fields are saved to push the current
 * values onto all of that user's Label/ColorLabel bindings. Unlike location
 * reconciliation there's no ambiguity here — the live user record is always
 * the single correct source — so this always fixes every mismatch found.
 *
 * Pass `{ apply: false }` to compute what would change without writing —
 * used by scripts/backfill-label-userid.js and any other one-off catch-up
 * script for a dry run.
 */
export async function syncLabelBindingIdentity(userId, { apply = true } = {}) {
  const user = await Username.findById(userId)
    .select("clientName userName userContact label colorLabel")
    .populate(IDENTITY_BINDING_TYPES.map(([, field]) => ({ path: field, select: "clientName userName userContact" })))
    .lean();

  if (!user) return { fixed: [] };

  const fixed = [];

  for (const [Model, field] of IDENTITY_BINDING_TYPES) {
    const items = user[field] || [];
    const ops = [];

    for (const item of items) {
      if (!item) continue;
      const mismatch =
        item.clientName !== user.clientName ||
        item.userName !== user.userName ||
        item.userContact !== user.userContact;
      if (!mismatch) continue;

      ops.push({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { clientName: user.clientName, userName: user.userName, userContact: user.userContact } },
        },
      });
      fixed.push({
        type: field,
        id: item._id,
        from: { clientName: item.clientName, userName: item.userName, userContact: item.userContact },
        to: { clientName: user.clientName, userName: user.userName, userContact: user.userContact },
      });
    }

    if (!apply) continue;

    if (ops.length) {
      await Model.collection.bulkWrite(ops, { ordered: false });
    }
  }

  return { fixed };
}
