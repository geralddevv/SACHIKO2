// Location rows for the Edit User form/dialog. Dispatch details are per
// location; for legacy users whose stored locationDetails predate that, the
// primary (first) location's dispatch is backfilled from the top-level fields
// so editing doesn't wipe the existing dispatch info.
export function editLocationRows(user) {
  const stored = Array.isArray(user.locationDetails) && user.locationDetails.length
    ? user.locationDetails.map((loc) => (loc?.toObject ? loc.toObject() : { ...loc }))
    : [{ userLocation: user.userLocation || "", dispatchAddress: user.dispatchAddress || "" }];

  const hasPrimaryDispatch = stored[0] && (
    stored[0].selfDispatch || stored[0].transportName || stored[0].transportContact ||
    stored[0].dropLocation || stored[0].deliveryMode || stored[0].deliveryLocation || stored[0].clientPayment
  );
  if (stored[0] && !hasPrimaryDispatch) {
    stored[0] = {
      ...stored[0],
      selfDispatch: user.SelfDispatch || "",
      transportName: user.transportName || "",
      transportContact: user.transportContact || "",
      dropLocation: user.dropLocation || "",
      deliveryMode: user.deliveryMode || "",
      deliveryLocation: user.deliveryLocation || "",
      clientPayment: user.clientPayment || "",
    };
  }
  return stored;
}
