// Shared "Verified" sign-off (blue badge + who/when) -- see VERIFICATION.md.
// Schema: spread `verificationFields` into a model.
// Routes: `verificationUpdate(req, existing)` -> { set, unset } to merge into
// the create/update call. Client side: public/js/verification.js.
export const verificationFields = {
  verified: { type: Boolean, default: false },
  verifiedBy: { type: String, trim: true },
  verifiedAt: { type: Date },
};

const TICKED = ["on", "true", "1"];

// Reads the `verified` checkbox from the request body.
//   ticked, not yet verified -> stamp the logged-in user + now
//   ticked, already verified -> keep the original approver and time
//   not ticked               -> clear the approval
export function verificationUpdate(req, existing) {
  const ticked = TICKED.includes(String(req.body?.verified ?? "").toLowerCase());
  if (!ticked) return { set: {}, unset: { verified: "", verifiedBy: "", verifiedAt: "" } };
  if (existing?.verified && existing.verifiedBy) return { set: {}, unset: {} };
  const u = req.session?.authUser;
  return {
    set: { verified: true, verifiedBy: u?.username || u?.empName || "UNKNOWN", verifiedAt: new Date() },
    unset: {},
  };
}
