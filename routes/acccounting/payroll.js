import express from "express";
import Employee from "../../models/hr/employee_model.js";
import Payroll from "../../models/accounting/Payroll.js";
import PayrollLog from "../../models/accounting/PayrollLog.js";
import Loan from "../../models/accounting/Loan.js";
import LoanLog from "../../models/accounting/LoanLog.js";
import Advance from "../../models/accounting/advance.js";
import AdvanceLog from "../../models/accounting/AdvanceLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* SHOW PAYROLL FORM */
router.get("/create", async (req, res) => {
  const employees = await Employee.find({ isActive: true }).sort({ empName: 1 });
  const existingPayrolls = await PayrollLog.find({}, "employee month year").lean();

  res.render("accounting/payroll", {
    employees,
    existingPayrolls: existingPayrolls.map((p) => ({
      employee: String(p.employee),
      month: p.month,
      year: p.year,
    })),
    CSS: false,
    JS: false,
    title: "Payroll",
    navigator: "payroll",
    notification: req.flash("notification"),
    error: req.flash("error"),
  });
});

/* CREATE PAYROLL */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, month, year, presentDays, absentDays, othrs = 0, incentive = 0 } = req.body;

    /* FETCH EMPLOYEE */
    const emp = await Employee.findById(employeeId);
    if (!emp) {
      req.flash("error", "Employee not found");
      return res.redirect("back");
    }
    /* FETCH EMI FROM LOAN MASTER */
    let emiAmount = 0;
    const loan = await Loan.findOne({ employee: emp._id });

    if (loan && loan.status === "ACTIVE") {
      emiAmount = loan.emi;
    }

    /* BLOCK DUPLICATE PAYROLL (LOG LEVEL) */
    const alreadyLogged = await PayrollLog.findOne({
      employee: employeeId,
      month,
      year,
    });

    if (alreadyLogged) {
      req.flash("error", "Payroll already exists for this employee and month");
      return res.redirect("back");
    }

    /* ADVANCE (DEDUCTION RULE) */
    const advanceRecord = await Advance.findOne({ employee: employeeId });
    let advanceDeduction = 0;

    if (advanceRecord && advanceRecord.currentBalance > 0) {
      const maxAdvanceAllowed = emp.basicSalary * 0.5;
      advanceDeduction = Math.min(advanceRecord.currentBalance, maxAdvanceAllowed);
    }

    /* ABSENT CALCULATION */
    const totalDays = Number(presentDays) + Number(absentDays);
    const perDaySalary = totalDays ? emp.basicSalary / totalDays : 0;
    const absentAmount = Number(absentDays) * perDaySalary;

    /* ADDITIONS */
    const otAmount = Number(req.body.empOtAmount || 0);
    const houseRent = Number(req.body.houseRent || 0);
    const travelling = Number(req.body.travelling || 0);
    const railwayPass = Number(req.body.railwayPass || 0);
    const bonus = Number(req.body.bonus || 0);

    const totalAdditions = otAmount + houseRent + travelling + railwayPass + bonus;

    /* GROSS SALARY */
    const grossSalary = Number((Number(emp.basicSalary) + totalAdditions + Number(incentive)).toFixed(2));

    /* DEDUCTIONS */
    const empPT = Number(req.body.empPT ?? emp.empPT ?? 0);

    /* TOTAL DEDUCTIONS */
    const totalDeduction = Number(
      (
        empPT +
        absentAmount +
        advanceDeduction +
        emiAmount
      ).toFixed(2),
    );

    /* TAKE AWAY */
    const takeAway = Number(Math.max(grossSalary - totalDeduction, 0).toFixed(2));

    /* UPSERT PAYROLL (SNAPSHOT) */
    const payroll = await Payroll.findOneAndUpdate(
      { employee: emp._id },
      {
        employee: emp._id,
        month,
        year,
        presentDays,
        absentDays,
        otHours: othrs,

        baseSalary: emp.basicSalary,
        totalAdditions,
        incentive,
        advance: advanceDeduction,

        grossSalary,
        totalDeduction,
        takeAway,
      },
      { upsert: true, new: true },
    );

    /* PAYROLL LOG (HISTORY) */
    await PayrollLog.create({
      employee: emp._id,
      payroll: payroll._id,

      month,
      year,

      baseSalary: emp.basicSalary,
      presentDays,
      absentDays,
      otHours: othrs,

      totalAdditions,
      incentive,
      advance: advanceDeduction,

      grossSalary,
      totalDeduction,
      takeAway,

      source: "SYSTEM",
    });

    /* LOAN EMI DEDUCTION */
    if (emiAmount > 0 && loan) {
      const openingBalance = loan.currentBalance;
      const closingBalance = Math.max(openingBalance - emiAmount, 0);

      loan.currentBalance = closingBalance;
      loan.status = closingBalance === 0 ? "CLOSED" : "ACTIVE";
      await loan.save();

      await LoanLog.create({
        employee: emp._id,
        loan: loan._id,
        openingBalance,
        amount: emiAmount,
        closingBalance,
        type: "DEBIT",
        source: "PAYROLL",
        month,
        year,
      });
    }

    /* ADVANCE (LOGGED) */
    if (advanceDeduction > 0 && advanceRecord) {
      const openingBalance = advanceRecord.currentBalance;
      const closingBalance = openingBalance - advanceDeduction;

      advanceRecord.currentBalance = closingBalance;
      advanceRecord.status = closingBalance === 0 ? "CLOSED" : "ACTIVE";
      await advanceRecord.save();

      await AdvanceLog.create({
        employee: emp._id,
        advance: advanceRecord._id,
        openingBalance,
        amount: advanceDeduction,
        closingBalance,
        type: "DEBIT",
        source: "PAYROLL",
        month,
        year,
      });
    }

    res.locals.auditDescription = `Created payroll for "${emp.empName}" (${month}/${year}, take-away ₹${takeAway})`;
    req.flash("notification", "Payroll created successfully");
    return res.redirect("/fairtech/payroll/view");
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to create payroll");
    return res.redirect("back");
  }
});

/* FETCH LOAN */
router.get("/loan/:employeeId", async (req, res) => {
  try {
    const loan = await Loan.findOne({ employee: req.params.employeeId }).lean();
    res.json(loan || { currentBalance: 0 });
  } catch (err) {
    console.error("FETCH LOAN ERROR:", err);
    res.status(500).json({ error: "Failed to fetch loan." });
  }
});

/* FETCH ADVANCE */
router.get("/advance/:employeeId", async (req, res) => {
  try {
    const advance = await Advance.findOne({ employee: req.params.employeeId }).lean();
    res.json(advance || { currentBalance: 0 });
  } catch (err) {
    console.error("FETCH ADVANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch advance." });
  }
});

/* PAYROLL DISPLAY (FULL MONTH-WISE HISTORY, FILTERABLE BY MONTH) */
router.get("/view", async (req, res) => {
  try {
    const logs = await PayrollLog.find({})
      .sort({ year: -1, month: -1, createdAt: -1 })
      .populate("employee", "empName empId")
      .lean();

  const jsonData = logs.map((p) => ({
    _id: p._id,
    employeeId: p.employee?._id,
    employeeName: p.employee?.empName || "-",
    empId: p.employee?.empId || "-",
    month: p.month,
    year: p.year,

    presentDays: p.presentDays,
    absentDays: p.absentDays,
    otHours: p.otHours,

    basicSalary: p.baseSalary || 0,
    totalAdditions: p.totalAdditions || 0,
    incentive: p.incentive || 0,
    advance: p.advance || 0,

    grossSalary: p.grossSalary,
    totalDeduction: p.totalDeduction,
    takeAway: p.takeAway,

    source: p.source,
  }));

  const now = new Date();

    res.render("accounting/payrollDisp", {
      jsonData,
      currentMonth: now.getMonth() + 1,
      currentYear: now.getFullYear(),
      CSS: "tableDisp.css",
      JS: false,
      title: "Payroll View",
      navigator: "payroll",
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("PAYROLL VIEW ERROR:", err);
    res.status(500).render("accounting/payrollDisp", {
      jsonData: [],
      currentMonth: new Date().getMonth() + 1,
      currentYear: new Date().getFullYear(),
      CSS: "tableDisp.css",
      JS: false,
      title: "Payroll View",
      navigator: "payroll",
      error: ["Failed to load payroll records."],
    });
  }
});

/* EDIT PAYROLL RECORD */
router.patch("/logs/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PayrollLog.findById(id);
    if (!log) return res.status(404).json({ message: "Payroll record not found." });

    const presentDays = Number(req.body.presentDays ?? log.presentDays);
    const absentDays = Number(req.body.absentDays ?? log.absentDays);
    const otHours = Number(req.body.otHours ?? log.otHours);
    const incentive = Number(req.body.incentive ?? log.incentive);
    const totalAdditions = Number(req.body.totalAdditions ?? log.totalAdditions);
    const advance = Number(req.body.advance ?? log.advance);
    const totalDeduction = Number(req.body.totalDeduction ?? log.totalDeduction);

    const grossSalary = Number((Number(log.baseSalary) + totalAdditions + incentive).toFixed(2));
    const takeAway = Number(Math.max(grossSalary - totalDeduction, 0).toFixed(2));

    log.presentDays = presentDays;
    log.absentDays = absentDays;
    log.otHours = otHours;
    log.incentive = incentive;
    log.totalAdditions = totalAdditions;
    log.advance = advance;
    log.totalDeduction = totalDeduction;
    log.grossSalary = grossSalary;
    log.takeAway = takeAway;
    await log.save();

    // Keep the employee's latest Payroll snapshot in sync, if this log is that snapshot
    const payroll = await Payroll.findById(log.payroll);
    if (payroll && payroll.month === log.month && payroll.year === log.year) {
      payroll.presentDays = presentDays;
      payroll.absentDays = absentDays;
      payroll.otHours = otHours;
      payroll.incentive = incentive;
      payroll.totalAdditions = totalAdditions;
      payroll.advance = advance;
      payroll.grossSalary = grossSalary;
      payroll.totalDeduction = totalDeduction;
      payroll.takeAway = takeAway;
      await payroll.save();
    }

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Edited payroll record for "${empDoc?.empName || log.employee}" (${log.month}/${log.year}, take-away ₹${takeAway})`;
    req.flash("notification", "Payroll record updated");
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: "Failed to update payroll record." });
  }
});

/* DELETE PAYROLL RECORD (reverses linked loan EMI / advance deductions) */
router.delete("/logs/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PayrollLog.findById(id);
    if (!log) return res.status(404).json({ message: "Payroll record not found." });

    /* REVERSE LOAN EMI DEDUCTION TIED TO THIS PAYROLL RUN */
    const loanDebit = await LoanLog.findOne({
      employee: log.employee,
      month: log.month,
      year: log.year,
      source: "PAYROLL",
      type: "DEBIT",
    });

    if (loanDebit) {
      const loan = await Loan.findById(loanDebit.loan);
      if (loan) {
        const openingBalance = loan.currentBalance;
        const closingBalance = openingBalance + loanDebit.amount;

        loan.currentBalance = closingBalance;
        loan.status = "ACTIVE";
        await loan.save();

        await LoanLog.create({
          employee: log.employee,
          loan: loan._id,
          openingBalance,
          amount: loanDebit.amount,
          closingBalance,
          type: "CREDIT",
          source: "PAYROLL",
          month: log.month,
          year: log.year,
        });
      }
    }

    /* REVERSE ADVANCE DEDUCTION TIED TO THIS PAYROLL RUN */
    const advanceDebit = await AdvanceLog.findOne({
      employee: log.employee,
      month: log.month,
      year: log.year,
      source: "PAYROLL",
      type: "DEBIT",
    });

    if (advanceDebit) {
      const advanceRecord = await Advance.findById(advanceDebit.advance);
      if (advanceRecord) {
        const openingBalance = advanceRecord.currentBalance;
        const closingBalance = openingBalance + advanceDebit.amount;

        advanceRecord.currentBalance = closingBalance;
        advanceRecord.status = "ACTIVE";
        await advanceRecord.save();

        await AdvanceLog.create({
          employee: log.employee,
          advance: advanceRecord._id,
          openingBalance,
          amount: advanceDebit.amount,
          closingBalance,
          type: "CREDIT",
          source: "PAYROLL",
          month: log.month,
          year: log.year,
        });
      }
    }

    await PayrollLog.findByIdAndDelete(id);

    /* REBUILD THE EMPLOYEE'S PAYROLL SNAPSHOT FROM REMAINING HISTORY */
    const remainingLogs = await PayrollLog.find({ employee: log.employee }).sort({ year: -1, month: -1, createdAt: -1 });

    if (remainingLogs.length) {
      const latest = remainingLogs[0];
      await Payroll.findOneAndUpdate(
        { employee: log.employee },
        {
          employee: log.employee,
          month: latest.month,
          year: latest.year,
          presentDays: latest.presentDays,
          absentDays: latest.absentDays,
          otHours: latest.otHours,
          totalAdditions: latest.totalAdditions,
          incentive: latest.incentive,
          advance: latest.advance,
          grossSalary: latest.grossSalary,
          totalDeduction: latest.totalDeduction,
          takeAway: latest.takeAway,
        },
        { upsert: true },
      );
    } else {
      await Payroll.findOneAndDelete({ employee: log.employee });
    }

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Deleted payroll record for "${empDoc?.empName || log.employee}" (${log.month}/${log.year}) and reversed linked loan/advance deductions`;
    req.flash("notification", "Payroll record deleted");
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: "Failed to delete payroll record." });
  }
});

/* EMPLOYEE PAYROLL HISTORY */
router.get("/employee/:id/payrolls", async (req, res) => {
  try {
    const logs = await PayrollLog.find({ employee: req.params.id })
      .sort({ year: -1, month: -1 })
      .populate("employee", "empName empId")
      .lean();

    const history = logs.map((p) => ({
      _id: p._id,
      employeeId: p.employee?._id,
      employeeName: p.employee?.empName || "-",
      empId: p.employee?.empId || "-",

      month: p.month,
      year: p.year,

      presentDays: p.presentDays,
      absentDays: p.absentDays,
      otHours: p.otHours,

      basicSalary: p.baseSalary,
      totalAdditions: p.totalAdditions,
      incentive: p.incentive,
      advance: p.advance,

      grossSalary: p.grossSalary,
      totalDeduction: p.totalDeduction,
      takeAway: p.takeAway,

      source: p.source,
    }));

    res.json({ history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ history: [] });
  }
});

/* FETCH EMPLOYEE (FOR PAYROLL & ADVANCE) */
router.get("/employee/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).select("empId empName basicSalary").lean();

    if (!emp) return res.status(404).json(null);

    res.json({
      _id: emp._id,
      empId: emp.empId,
      empName: emp.empName,
      basicSalary: emp.basicSalary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

export default router;
