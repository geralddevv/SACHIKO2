import Employee from "../models/hr/employee_model.js";
import { normalizeLocationName } from "./locations.js";
import { escapeRegex } from "./security.js";

/*
 * Shared operator-login matching logic, used by both the EJS operator portal
 * (POST /sachiko/operator/login in server.js) and the JSON operator API
 * (POST /sachiko/api/operator/login in routes/api/operatorApi.js) so the two
 * never drift apart.
 *
 * Operators sign in with their nick name (empNickName), their location, and
 * their password -- not the full three-word name. A nick name isn't unique on
 * its own, so match on nick name + location, the location being the unit the
 * operator works at. Where several operators at one unit share a nick name,
 * the password decides between them, rather than testing only the first
 * match and rejecting everyone else.
 *
 * Stored values carry stray leading/trailing and doubled spaces, so an
 * exact-anchored match would miss them. Collapse the typed value's runs of
 * whitespace and match tolerantly: optional surrounding whitespace, and any
 * run of whitespace between words.
 */
export async function authenticateOperator({ operatorNick, location, password }) {
  const nick = String(operatorNick || "").trim();
  const locationName = normalizeLocationName(location);
  const pass = String(password || "").trim();

  if (!nick || !locationName || !pass) {
    return { error: "Please fill in all three fields.", status: 400 };
  }

  const nickCollapsed = nick.replace(/\s+/g, " ");
  const nickPattern = `^\\s*${escapeRegex(nickCollapsed).replace(/ /g, "\\s+")}\\s*$`;
  const candidates = await Employee.find({
    empNickName: { $regex: new RegExp(nickPattern, "i") },
    isActive: true,
  });
  const isOperatorProfile = (emp) => String(emp.empProfile || "").trim().toUpperCase() === "OPERATOR";
  // Operators first, so an operator sharing a nick name with a staff member at
  // the same unit still gets in -- while a staff member who has this page to
  // themselves still falls through to the "operators only" message below.
  const atLocation = candidates
    .filter((emp) => normalizeLocationName(emp.empLoc) === locationName)
    .sort((a, b) => Number(isOperatorProfile(b)) - Number(isOperatorProfile(a)));

  let employee = null;
  for (const candidate of atLocation) {
    if (await candidate.comparePassword(pass)) {
      employee = candidate;
      break;
    }
  }

  if (!employee) {
    return { error: "Invalid nick name, location or password.", status: 401 };
  }
  // The profile itself is the gate here -- operators carry role "none" (no
  // staff-portal access), which is exactly why this portal exists. Whether
  // the account is live is decided by isActive in the query above.
  if (!isOperatorProfile(employee)) {
    return { error: "This login is for operators only. Please use the staff login.", status: 403 };
  }

  return {
    employee,
    authUser: {
      username: employee.empName,
      empName: employee.empName,
      // The short call-name operators are actually known by on the floor --
      // what they sign in with, and what the mobile app greets them by.
      empNickName: employee.empNickName,
      profileCode: employee.empProfileCode,
      role: "operator",
      permissions: employee.permissions,
      empId: employee.empId,
      // The employee document _id, used to pull this operator's assigned jobs
      // (PendingProduction.operatorId) on the work-queue landing page.
      empObjId: String(employee._id),
      empPhoto: employee.empPhoto,
      empLoc: employee.empLoc,
    },
  };
}
