// Helpers for working with a user's set of locations (locationDetails[]).

// Normalize a location name to the stored/display form: uppercase, single
// spaces, no leading/trailing dots or commas. Mirrors the client-side
// normalizeLocationName used in the binding forms.
export function normalizeLocationName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

// Build a de-duplicated, uppercase list of a user's location names, preferring
// locationDetails[] and falling back to the top-level userLocation. When
// `currentLocation` is given it is always included, so a binding's existing
// location remains selectable even if the user's locations later changed.
export function getUserLocationNames(user, currentLocation = "") {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const n = normalizeLocationName(v);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };

  const details = Array.isArray(user?.locationDetails) ? user.locationDetails : [];
  for (const d of details) add(d?.userLocation || d?.location);
  if (out.length === 0) add(user?.userLocation);
  add(currentLocation);

  return out;
}
