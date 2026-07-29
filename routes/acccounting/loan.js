import express from "express";
import mongoose from "mongoose";
import Employee from "../../models/hr/employee_model.js";
import Loan from "../../models/accounting/Loan.js";
import LoanLog from "../../models/accounting/LoanLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function sortLoanLogs(logs) {
  return [...logs].sort((a, b) => {
    const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a._id).localeCompare(String(b._id));
  });
}

function isLoanResetLog(log, nextLog) {
  return (
    log?.source === "MANUAL" &&
    log?.type === "DEBIT" &&
    nextLog?.source === "MANUAL" &&
    nextLog?.type === "CREDIT"
  );
}

async function recomputeLoanLogs(employeeId, loanId, { overrideId = null, overrideAmount = null, deleteIds = [] } = {}) {
  const logs = sortLoanLogs(await LoanLog.find({ employee: employeeId }).lean());
  const deleteSet = new Set(deleteIds.map((id) => String(id)));
  const ops = [];
  let running = 0;
  let pendingResetBase = null;

  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    const nextLog = logs[i + 1];

    if (deleteSet.has(String(log._id))) {
      continue;
    }

    const isOverride = overrideId && String(log._id) === String(overrideId);
    const amount = isOverride ? overrideAmount : log.amount;
    let openingBalance = running;
    let closingBalance = running;

    if (isLoanResetLog(log, nextLog) && !deleteSet.has(String(nextLog?._id))) {
      openingBalance = running;
      closingBalance = 0;
      pendingResetBase = running;
    } else if (pendingResetBase !== null && log.source === "MANUAL" && log.type === "CREDIT") {
      openingBalance = pendingResetBase;
      closingBalance = pendingResetBase + amount;
      pendingResetBase = null;
    } else if (log.type === "CREDIT") {
      openingBalance = running;
      closingBalance = running + amount;
      pendingResetBase = null;
    } else {
      openingBalance = running;
      closingBalance = running - amount;
      pendingResetBase = null;
    }

    if (closingBalance < 0) {
      throw new Error("This change would make the loan balance negative.");
    }

    const update = {};
    if (openingBalance !== log.openingBalance) update.openingBalance = openingBalance;
    if (closingBalance !== log.closingBalance) update.closingBalance = closingBalance;
    if (isLoanResetLog(log, nextLog) && amount !== openingBalance) update.amount = openingBalance;
    if (isOverride && amount !== log.amount) update.amount = amount;

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

  if (deleteSet.size) {
    for (const deleteId of deleteSet) {
      ops.push({
        deleteOne: {
          filter: { _id: deleteId },
        },
      });
    }
  }

  if (ops.length) {
    await LoanLog.bulkWrite(ops);
  }

  const loan = await Loan.findById(loanId);
  if (!loan) {
    throw new Error("Loan record not found.");
  }

  loan.currentBalance = running;
  loan.status = running === 0 ? "CLOSED" : "ACTIVE";
  await loan.save();

  return {
    currentBalance: running,
    status: loan.status,
    emi: loan.emi,
    updatedAt: loan.updatedAt,
  };
}

/* SHOW LOAN FORM */
router.get("/create", async (req, res) => {
  const employees = await Employee.find({ isActive: true });

  res.render("accounting/loan", {
    employees,
    CSS: false,
    JS: false,
    title: "Loan",
    navigator: "loan",
    notification: req.flash("notification"),
    error: req.flash("error"),
  });
});

/* ADD / RE-ISSUE LOAN */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, loanAmount } = req.body;
    const amount = Number(loanAmount) || 0;

    // accept both names safely
    const newEmi = Number(req.body.emi) || Number(req.body.emiAmount) || 0;

    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Please select an employee." });
    }

    if (amount <= 0) {
      return res.status(400).json({ success: false, message: "Loan amount must be greater than 0." });
    }

    if (newEmi <= 0) {
      return res.status(400).json({ success: false, message: "EMI amount must be greater than 0." });
    }

    const empObjectId = new mongoose.Types.ObjectId(employeeId);
    const empDoc = await Employee.findById(empObjectId).select("empName").lean();
    const empName = empDoc?.empName || employeeId;

    let loan = await Loan.findOne({ employee: empObjectId });

    /* FIRST TIME LOAN */
    if (!loan) {
      const newLoan = await Loan.create({
        employee: empObjectId,
        currentBalance: amount,
        emi: newEmi,
        status: "ACTIVE",
      });

      await LoanLog.create({
        employee: empObjectId,
        loan: newLoan._id,
        openingBalance: 0,
        amount: amount,
        closingBalance: amount,
        type: "CREDIT",
        source: "MANUAL",
      });

      res.locals.auditDescription = `Issued loan of ₹${amount} for "${empName}" (EMI ₹${newEmi})`;
      req.flash("notification", "Loan issued successfully");
      return res.json({ success: true, redirect: "/fairtech/loan/view" });
    }

    /* LOAN RE-ISSUE (TOP-UP / CONSOLIDATION) */

    const oldBalance = loan.currentBalance;

    /* 1. CLOSE OLD LOAN BALANCE */
    await LoanLog.create({
      employee: empObjectId,
      loan: loan._id,
      openingBalance: oldBalance,
      amount: oldBalance,
      closingBalance: 0,
      type: "DEBIT",
      source: "MANUAL",
    });

    /* 2. UPDATE LOAN MASTER (OVERRIDE EMI) */
    const consolidatedAmount = oldBalance + amount;

    loan.currentBalance = consolidatedAmount;
    loan.emi = newEmi; //  EMI OVERRIDDEN (NOT ADDED)
    loan.status = "ACTIVE";
    await loan.save();

    /* 3. LOG ONLY THE TOP-UP */
    await LoanLog.create({
      employee: empObjectId,
      loan: loan._id,
      openingBalance: oldBalance,
      amount: amount, // only top-up amount
      closingBalance: consolidatedAmount,
      type: "CREDIT",
      source: "MANUAL",
    });

    res.locals.auditDescription = `Re-issued/topped-up loan of ₹${amount} for "${empName}" (new balance ₹${consolidatedAmount}, EMI ₹${newEmi})`;
    req.flash("notification", "Loan re-issued successfully");
    return res.json({ success: true, redirect: "/fairtech/loan/view" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to issue loan" });
  }
});

/* LOAN DISPLAY */
router.get("/view", async (req, res) => {
  const loans = await Loan.find().populate("employee", "empName empId").sort({ updatedAt: -1 }).lean();

  const jsonData = loans.map((l) => ({
    employeeId: l.employee?._id,
    employeeName: l.employee?.empName || "-",
    empId: l.employee?.empId || "-",
    currentBalance: l.currentBalance,
    emi: l.emi || 0,
    status: l.status,
    updatedAt: new Date(l.updatedAt).toLocaleDateString(),
  }));

  res.render("accounting/loanDisp", {
    jsonData,
    title: "Loan View",
    CSS: "tableDisp.css",
    JS: false,
    navigator: "loan",
  });
});

/* LOAN ACTION LOGS */
router.get("/logs", async (req, res) => {
  try {
    const logs = await LoanLog.find()
      .populate("employee", "empName empId")
      .populate("loan", "currentBalance emi status")
      .sort({ createdAt: -1 })
      .lean();

    const formatted = logs.map((log) => ({
      _id: log._id,
      employeeName: log.employee?.empName || "-",
      empId: log.employee?.empId || "-",
      loanStatus: log.loan?.status || "-",
      loanBalance: log.loan?.currentBalance ?? 0,
      openingBalance: log.openingBalance ?? 0,
      amount: log.amount ?? 0,
      closingBalance: log.closingBalance ?? 0,
      type: log.type || "-",
      source: log.source || "-",
      action:
        log.type === "CREDIT" && log.source === "MANUAL"
          ? log.openingBalance === 0
            ? "INITIAL LOAN"
            : "LOAN TOP-UP"
          : log.type === "DEBIT" && log.source === "MANUAL"
            ? "LOAN CLOSE"
            : log.type === "DEBIT" && log.source === "PAYROLL"
              ? "EMI DEDUCTION"
              : "-",
      date: new Date(log.createdAt).toLocaleDateString("en-IN"),
      time: new Date(log.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    }));

    res.render("accounting/loanLogs.ejs", {
      logs: formatted,
      title: "Loan Logs",
      CSS: "tableDisp.css",
      JS: false,
      navigator: "loan",
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load loan logs");
    res.redirect("/fairtech/loan/view");
  }
});

/* EMPLOYEE LOAN LOG HISTORY */
router.get("/employee/:employeeId/logs", async (req, res) => {
  const { employeeId } = req.params;

  const logs = await LoanLog.find({ employee: employeeId })
    .populate("employee", "empName empId")
    .sort({ createdAt: -1 })
    .lean();

  if (!logs.length) {
    return res.json({ history: [] });
  }

  const formatted = logs.map((l) => ({
    _id: l._id,
    employeeName: l.employee?.empName || "-",
    empId: l.employee?.empId || "-",

    openingBalance: l.openingBalance,
    amount: l.amount,
    closingBalance: l.closingBalance,

    type: l.type, // CREDIT / DEBIT
    source: l.source, // MANUAL / PAYROLL
    canEdit: l.source === "MANUAL" && l.type === "CREDIT",
    canDelete: l.source === "MANUAL" && l.type === "CREDIT",
    createdAt: l.createdAt,
    date: new Date(l.createdAt).toLocaleDateString(),
  }));

  const latest = logs[0];

  res.json({
    summary: {
      currentBalance: latest.closingBalance,
      status: latest.closingBalance === 0 ? "CLOSED" : "ACTIVE",
    },
    history: formatted,
  });
});

router.patch("/logs/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const amount = Number(req.body.amount) || 0;

    if (amount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0." });
    }

    const log = await LoanLog.findById(id);
    if (!log) {
      return res.status(404).json({ message: "Loan log not found." });
    }

    if (log.source !== "MANUAL" || log.type !== "CREDIT") {
      return res.status(400).json({ message: "Only manual loan entries can be edited." });
    }

    const summary = await recomputeLoanLogs(log.employee, log.loan, {
      overrideId: log._id,
      overrideAmount: amount,
    });

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Edited loan log entry for "${empDoc?.empName || log.employee}" (amount ₹${amount})`;
    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("UPDATE LOAN LOG ERROR:", err);
    return res.status(500).json({ message: "Failed to update loan log." });
  }
});

router.delete("/logs/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await LoanLog.findById(id);

    if (!log) {
      return res.status(404).json({ message: "Loan log not found." });
    }

    if (log.source !== "MANUAL" || log.type !== "CREDIT") {
      return res.status(400).json({ message: "Only manual loan entries can be deleted." });
    }

    const logs = sortLoanLogs(await LoanLog.find({ employee: log.employee }).lean());
    const index = logs.findIndex((item) => String(item._id) === String(log._id));
    const deleteIds = [log._id];

    if (index > 0) {
      const previousLog = logs[index - 1];
      if (isLoanResetLog(previousLog, log)) {
        deleteIds.push(previousLog._id);
      }
    }

    const summary = await recomputeLoanLogs(log.employee, log.loan, {
      deleteIds,
    });

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Deleted loan log entry for "${empDoc?.empName || log.employee}" (amount ₹${log.amount})`;
    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("DELETE LOAN LOG ERROR:", err);
    return res.status(500).json({ message: "Failed to delete loan log." });
  }
});

export default router;
