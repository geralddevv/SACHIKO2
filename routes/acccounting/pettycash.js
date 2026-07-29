import express from "express";
import PettyCash from "../../models/accounting/PettyCash.js";
import PettyCashLog from "../../models/accounting/PettyCashLog.js";
import Employee from "../../models/hr/employee_model.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* READ ONLY (NO SIDE EFFECTS) */
async function findPettyCash(location) {
  return await PettyCash.findOne({ location });
}

/* CREATE ONLY WHEN TXN IS VALID */
async function getOrCreatePettyCash(location) {
  let petty = await PettyCash.findOne({ location });

  if (!petty) {
    petty = await PettyCash.create({
      location,
      currentBalance: 0,
    });
  }

  return petty;
}

function normalizeEntryDate(value) {
  if (!value) return new Date().toISOString().split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return null;
  }
  return value;
}

function entryDateSortValue(log) {
  return log.entryDate || (log.createdAt ? new Date(log.createdAt).toISOString().split("T")[0] : "1970-01-01");
}

function getLogDateForMonthTotals(log) {
  const raw = String(log?.entryDate || log?.createdAt || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getCurrentMonthExpense(logs) {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  return (logs || []).reduce((sum, log) => {
    const d = getLogDateForMonthTotals(log);
    if (!d || d.getMonth() !== month || d.getFullYear() !== year) return sum;
    if (String(log?.type || "").toUpperCase() !== "OUTWARD") return sum;
    return sum + (Number(log?.amount) || 0);
  }, 0);
}

function getTotalExpense(logs) {
  return (logs || []).reduce((sum, log) => {
    if (String(log?.type || "").toUpperCase() !== "OUTWARD") return sum;
    return sum + (Number(log?.amount) || 0);
  }, 0);
}

function getTotalIncome(logs) {
  return (logs || []).reduce((sum, log) => {
    if (String(log?.type || "").toUpperCase() !== "INWARD") return sum;
    return sum + (Number(log?.amount) || 0);
  }, 0);
}

function sortPettyCashLogs(logs) {
  return [...logs].sort((a, b) => {
    const aDate = entryDateSortValue(a);
    const bDate = entryDateSortValue(b);
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;

    const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return String(a._id).localeCompare(String(b._id));
  });
}

async function recomputeLogsAndBalance(location, { overrideId = null, overrideDoc = null, deleteId = null } = {}) {
  const logs = sortPettyCashLogs(await PettyCashLog.find({ location }).lean());

  let running = 0;
  const ops = [];

  for (const log of logs) {
    if (deleteId && String(log._id) === String(deleteId)) {
      continue;
    }

    const isOverride = overrideId && String(log._id) === String(overrideId);
    const effective = isOverride ? { ...log, ...overrideDoc } : log;

    const openingBalance = running;
    const delta = effective.type === "INWARD" ? effective.amount : -effective.amount;
    const closingBalance = openingBalance + delta;

    if (closingBalance < 0) {
      throw new Error("Insufficient petty cash balance after update");
    }

    const update = {};
    if (openingBalance !== log.openingBalance) update.openingBalance = openingBalance;
    if (closingBalance !== log.closingBalance) update.closingBalance = closingBalance;

    if (isOverride) {
      if (effective.amount !== log.amount) update.amount = effective.amount;
      if (effective.type !== log.type) update.type = effective.type;
      if (effective.from !== log.from) update.from = effective.from;
      if (effective.to !== log.to) update.to = effective.to;
      if ((effective.reason || "") !== (log.reason || "")) update.reason = effective.reason || "";
      if ((effective.entryDate || "") !== (log.entryDate || "")) update.entryDate = effective.entryDate;
    }

    if (Object.keys(update).length) {
      ops.push({
        updateOne: {
          filter: { _id: log._id },
          update: { $set: update },
        },
      });
    }

    running = closingBalance;
  }

  if (deleteId) {
    ops.push({ deleteOne: { filter: { _id: deleteId } } });
  }

  if (ops.length) {
    await PettyCashLog.bulkWrite(ops);
  }

  const petty = await getOrCreatePettyCash(location);
  petty.currentBalance = running;
  await petty.save();

  return running;
}

/* SHOW ENTRY FORM */
router.get("/create", async (req, res) => {
  const employees = await Employee.find({ isActive: true }).select("empName").sort({ empName: 1 }).lean();

  res.render("accounting/pettycash", {
    title: "Petty Cash",
    navigator: "pettycash",
    CSS: false,
    JS: false,
    employees,
    notification: req.flash("notification"),
    error: req.flash("error"),
  });
});

/* ADD TRANSACTION */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { location, from, to, amount, type, reason, entryDate } = req.body;
    const txnAmount = Number(amount) || 0;
    const normalizedEntryDate = normalizeEntryDate(entryDate);

    /* BASIC VALIDATION */
    if (
      !location ||
      txnAmount <= 0 ||
      !type ||
      !normalizedEntryDate ||
      (type === "PAID" && !to) ||
      (type === "RECEIVED" && !from)
    ) {
      req.flash("error", "Invalid petty cash entry");
      return res.redirect("back");
    }

    /* UI → INTERNAL TYPE MAP */
    const internalType = type === "RECEIVED" ? "INWARD" : "OUTWARD";

    const petty = await getOrCreatePettyCash(location);
    const openingBalance = petty?.currentBalance ?? 0;
    const closingBalance = internalType === "INWARD" ? openingBalance + txnAmount : openingBalance - txnAmount;

    const createdLog = await PettyCashLog.create({
      location,

      from: internalType === "OUTWARD" ? "-" : (from && from.trim()) || "-",

      to: internalType === "INWARD" ? "-" : (to && to.trim()) || "-",

      openingBalance,
      amount: txnAmount,
      closingBalance,
      type: internalType,
      reason,
      entryDate: normalizedEntryDate,
    });

    try {
      await recomputeLogsAndBalance(location);
    } catch (recomputeErr) {
      await PettyCashLog.findByIdAndDelete(createdLog._id);
      await recomputeLogsAndBalance(location);
      throw recomputeErr;
    }

    res.locals.auditDescription = `Recorded petty cash ${type} of ₹${txnAmount} at "${location}" (${internalType === "OUTWARD" ? "to " + (to || "-") : "from " + (from || "-")})`;
    req.flash("notification", "Petty cash updated successfully");
    return res.redirect("/fairtech/pettycash/view");
  } catch (err) {
    console.error(err);
    req.flash("error", "Petty cash transaction failed");
    return res.redirect("back");
  }
});

/* SNAPSHOT (ALL LOCATIONS) */
router.get("/view", async (req, res) => {
  try {
    const pettyList = await PettyCash.find().lean();
    const allLogs = sortPettyCashLogs(await PettyCashLog.find({}).lean()).reverse();
    const totalPettyCash = pettyList.reduce((sum, p) => sum + (Number(p.currentBalance) || 0), 0);
    const currentMonthExpense = getCurrentMonthExpense(allLogs);

    const snapshot = pettyList.map((p) => ({
      location: p.location,
      balance: p.currentBalance,
      status: p.currentBalance > 0 ? "ACTIVE" : "EMPTY",
      updatedAt: p.updatedAt,
    }));

    const locationOptions = [...new Set(["OFFICE", "UNIT 1", "UNIT 2", ...pettyList.map((p) => p.location)])];
    const employees = await Employee.find({ isActive: true }).select("empName").sort({ empName: 1 }).lean();

    res.render("accounting/pettycashDisp", {
      jsonData: snapshot,
      allLogs,
      totalPettyCash,
      currentMonthExpense,
      locationOptions,
      employees,
      title: "Petty Cash View",
      navigator: "pettycash",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to load petty cash");
    res.redirect("back");
  }
});

/* LOCATION-WISE LOGS */
router.get("/logs/:location", async (req, res) => {
  try {
    const { location } = req.params;

    const logs = sortPettyCashLogs(await PettyCashLog.find({ location }).lean()).reverse();

    res.json({ history: logs });
  } catch (err) {
    res.status(500).json({ history: [] });
  }
});

/* LOCATION-WISE LOGS (VIEW) */
router.get("/logs/:location/view", async (req, res) => {
  try {
    const { location } = req.params;
    const { mode } = req.query;

    let logs;
    let balance = 0;
    let locationLabel = location;

    if (location === "all") {
      logs = sortPettyCashLogs(await PettyCashLog.find({}).lean()).reverse();
      const pettyList = await PettyCash.find().lean();
      balance = pettyList.reduce((sum, p) => sum + (Number(p.currentBalance) || 0), 0);
      locationLabel = "All Locations";
    } else {
      logs = sortPettyCashLogs(await PettyCashLog.find({ location }).lean()).reverse();
      const pettyCash = await findPettyCash(location);
      balance = pettyCash?.currentBalance || 0;
    }

    let viewLabel = "All Transactions";
    if (mode === "CURRENT") {
      const now = new Date();
      const month = now.getMonth();
      const year = now.getFullYear();
      logs = logs.filter((log) => {
        const d = getLogDateForMonthTotals(log);
        return d && d.getMonth() === month && d.getFullYear() === year;
      });
      viewLabel = "Current Month";
    }

    const pettyList = await PettyCash.find().lean();
    const allLocations = pettyList.map(p => p.location);
    const currentMonthExpense = getTotalExpense(logs);
    const currentMonthIncome = getTotalIncome(logs);

    res.render("accounting/pettycashLogs", {
      logs,
      location: locationLabel,
      balance,
      currentMonthExpense,
      currentMonthIncome,
      allLocations,
      viewLabel,
      mode,
      title: `Petty Cash Logs - ${locationLabel}`,
      navigator: "pettycash",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to load petty cash logs");
    res.redirect("/fairtech/pettycash/view");
  }
});

/* EDIT LOG */
router.patch("/logs/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PettyCashLog.findById(id);

    if (!log) {
      return res.status(404).json({ message: "Log not found" });
    }

    const { amount, type, from, to, reason, entryDate, location: newLocation } = req.body;
    const txnAmount = Number(amount) || 0;
    const normalizedEntryDate = normalizeEntryDate(entryDate);

    if (!["INWARD", "OUTWARD"].includes(type) || txnAmount <= 0 || !normalizedEntryDate) {
      return res.status(400).json({ message: "Invalid log update" });
    }

    if (type === "INWARD" && (!from || !from.trim())) {
      return res.status(400).json({ message: "From is required" });
    }

    if (type === "OUTWARD" && (!to || !to.trim())) {
      return res.status(400).json({ message: "To is required" });
    }

    const oldLocation = log.location;
    const isLocationChange = newLocation && newLocation.trim() && newLocation.trim() !== oldLocation;

    const overrideDoc = {
      amount: txnAmount,
      type,
      from: type === "INWARD" ? from.trim() : "-",
      to: type === "OUTWARD" ? to.trim() : "-",
      reason: (reason || "").trim(),
      entryDate: normalizedEntryDate,
    };

    if (isLocationChange) {
      // 1. Update the log to the new location FIRST
      log.location = newLocation.trim();
      Object.assign(log, overrideDoc);
      await log.save();

      // 2. Recompute the OLD location (it will no longer find this log)
      await recomputeLogsAndBalance(oldLocation);

      // 3. Recompute the NEW location (it will now include this log)
      await recomputeLogsAndBalance(newLocation.trim());
    } else {
      // Normal update within the same location
      await recomputeLogsAndBalance(oldLocation, {
        overrideId: log._id,
        overrideDoc,
      });
    }

    res.locals.auditDescription = `Edited petty cash log at "${isLocationChange ? newLocation.trim() : oldLocation}" (amount ₹${txnAmount}, type ${type})`;
    return res.json({ ok: true });
  } catch (err) {
    console.error("UPDATE PETTYCASH LOG ERROR:", err);
    return res.status(500).json({ message: "Failed to update log" });
  }
});

/* DELETE LOG */
router.delete("/logs/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PettyCashLog.findById(id);

    if (!log) {
      return res.status(404).json({ message: "Log not found" });
    }

    const balance = await recomputeLogsAndBalance(log.location, {
      deleteId: log._id,
    });

    res.locals.auditDescription = `Deleted petty cash log at "${log.location}" (amount ₹${log.amount}, type ${log.type})`;
    return res.json({ ok: true, balance });
  } catch (err) {
    console.error("DELETE PETTYCASH LOG ERROR:", err);
    return res.status(500).json({ message: "Failed to delete log" });
  }
});

/* LOCATION BALANCE (READ ONLY) */
router.get("/balance/:location", async (req, res) => {
  const { location } = req.params;

  const petty = await findPettyCash(location);

  res.json({
    balance: petty?.currentBalance ?? 0,
  });
});

export default router;
