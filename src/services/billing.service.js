const db = require("../config/db");
const {
  calculateNextServiceDate,
  canScheduleAnotherVisit,
} = require("../utils/serviceSchedule");

function parseDateValue(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  return new Date(`${value}T00:00:00`);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addMonths(dateValue, months) {
  const date = parseDateValue(dateValue);

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }

  const day = date.getDate();
  date.setMonth(date.getMonth() + months, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));

  return formatDate(date);
}

function getBillingCycle(planType) {
  const normalized = String(planType || "").trim().toLowerCase();

  if (normalized === "monthly") {
    return "monthly";
  }

  if (normalized === "one time" || normalized === "one-time" || normalized === "onetime") {
    return "one_time";
  }

  return "yearly";
}

function hasPlanBillingChange(existingPlan, nextPlan) {
  const nextBillingCycle = getBillingCycle(nextPlan.plan_type);

  return (
    String(existingPlan.plan_type || "") !== String(nextPlan.plan_type || "") ||
    String(existingPlan.frequency || "") !== String(nextPlan.frequency || "") ||
    Number(existingPlan.plan_price || 0) !== Number(nextPlan.plan_price || 0) ||
    String(existingPlan.billing_cycle || "") !== String(nextBillingCycle || "")
  );
}

function getNextBillingDate(dateValue, billingCycle, frequency = null) {
  if (billingCycle === "monthly") {
    return addMonths(dateValue, 1);
  }

  if (billingCycle === "yearly") {
    return addMonths(dateValue, 12);
  }

  return null;
}

function getInvoiceMonth(dateValue) {
  const date = parseDateValue(dateValue);

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }

  date.setDate(1);
  return formatDate(date);
}

function getInvoiceStatus({ paidAmount, balance, dueDate }) {
  const paid = Number(paidAmount || 0);
  const remaining = Number(balance || 0);
  const due = parseDateValue(dueDate);
  const today = parseDateValue(formatDate(new Date()));

  if (remaining <= 0) {
    return "paid";
  }

  if (due && due < today) {
    return "overdue";
  }

  if (paid > 0) {
    return "partial";
  }

  return "pending";
}

function getVisitsPerBillingCycle(frequency, billingCycle) {
  const normalizedFrequency = String(frequency || "").trim();

  if (billingCycle === "monthly") {
    const monthlyMatch = normalizedFrequency.match(/^(\d+)\/Month$/i);
    return monthlyMatch ? Number(monthlyMatch[1]) : 1;
  }

  if (billingCycle === "yearly") {
    const yearlyMatch = normalizedFrequency.match(/^(\d+)\/Year$/i);
    return yearlyMatch ? Number(yearlyMatch[1]) : 1;
  }

  return 1;
}

async function getCompletedVisitCountForPlan(connection, plan) {
  const [[visitCountRow]] = await connection.query(
    `SELECT COUNT(*) AS completed_visits
     FROM service_visits
     WHERE customer_id = ?
       AND status = 'completed'
       AND DATE(COALESCE(visit_date, next_service_date)) >= DATE(?)`,
    [plan.customer_id, plan.start_date]
  );

  return Number(visitCountRow.completed_visits || 0);
}

async function decorateInvoicesForCollection(connection, invoices) {
  const planState = new Map();

  for (const invoice of invoices) {
    if (!planState.has(invoice.customer_plan_id)) {
      planState.set(invoice.customer_plan_id, {
        invoices: [],
        completedVisits: await getCompletedVisitCountForPlan(connection, invoice),
        visitsPerCycle: getVisitsPerBillingCycle(invoice.frequency, invoice.billing_cycle),
      });
    }

    planState.get(invoice.customer_plan_id).invoices.push(invoice);
  }

  for (const state of planState.values()) {
    const orderedInvoices = [...state.invoices].sort((a, b) => {
      const aTime = parseDateValue(a.invoice_month)?.getTime() || 0;
      const bTime = parseDateValue(b.invoice_month)?.getTime() || 0;

      if (aTime !== bTime) {
        return aTime - bTime;
      }

      return Number(a.id || 0) - Number(b.id || 0);
    });

    orderedInvoices.forEach((invoice, index) => {
      const requiredCompletedVisits = index * state.visitsPerCycle;
      const isCollectible =
        invoice.billing_cycle === "one_time"
          ? index === 0
          : state.completedVisits >= requiredCompletedVisits;

      invoice.is_collectible = isCollectible ? 1 : 0;
      invoice.actual_status = invoice.status;
      invoice.actual_balance = invoice.balance;

      if (!isCollectible) {
        invoice.balance = 0;
        invoice.status = "upcoming";
      }
    });
  }

  return invoices;
}

async function getCustomerBillingSummary(connection, customerId) {
  await ensureInvoicesForCompletedServices(connection, customerId);

  const [invoices] = await connection.query(
    `SELECT
        i.*,
        cp.plan_type,
        cp.frequency,
        cp.billing_cycle,
        cp.start_date
     FROM invoices i
     JOIN customer_plans cp ON cp.id = i.customer_plan_id
     WHERE i.customer_id = ?`,
    [customerId]
  );

  const decoratedInvoices = await decorateInvoicesForCollection(
    connection,
    invoices
  );
  const collectibleInvoices = decoratedInvoices.filter(
    (invoice) => Number(invoice.is_collectible || 0) === 1
  );

  const currentInvoice =
    collectibleInvoices
      .filter((invoice) => Number(invoice.balance || 0) > 0)
      .sort((a, b) => {
        const aTime = parseDateValue(a.due_date)?.getTime() || 0;
        const bTime = parseDateValue(b.due_date)?.getTime() || 0;

        if (aTime !== bTime) {
          return aTime - bTime;
        }

        return Number(a.id || 0) - Number(b.id || 0);
      })[0] || null;

  return {
    total_amount: collectibleInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.amount || 0),
      0
    ),
    total_paid: decoratedInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.paid_amount || 0),
      0
    ),
    total_balance: collectibleInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.balance || 0),
      0
    ),
    current_invoice_id: currentInvoice?.id || null,
    current_invoice_status: currentInvoice?.status || null,
    current_invoice_due_date: currentInvoice?.due_date || null,
    current_invoice_month: currentInvoice?.invoice_month || null,
  };
}

async function createInvoiceIfMissing(connection, plan, invoiceDate) {
  const invoiceMonth = getInvoiceMonth(invoiceDate);
  const amount = Number(plan.plan_price || 0);

  const [existingRows] = await connection.query(
    `SELECT *
     FROM invoices
     WHERE customer_plan_id = ? AND invoice_month = ?
     LIMIT 1`,
    [plan.id, invoiceMonth]
  );

  if (existingRows.length) {
    return existingRows[0];
  }

  const [result] = await connection.query(
    `INSERT INTO invoices
     (customer_id, customer_plan_id, invoice_month, amount, paid_amount, balance, status, due_date)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      plan.customer_id,
      plan.id,
      invoiceMonth,
      amount,
      amount,
      amount > 0 ? getInvoiceStatus({ paidAmount: 0, balance: amount, dueDate: invoiceDate }) : "paid",
      invoiceDate,
    ]
  );

  const [[invoice]] = await connection.query(
    "SELECT * FROM invoices WHERE id = ? LIMIT 1",
    [result.insertId]
  );

  return invoice;
}

async function createNextInvoiceForPlan(connection, plan) {
  if (plan.status && plan.status !== "active") {
    return null;
  }

  if (plan.billing_cycle === "one_time") {
    return null;
  }

  if (!plan.next_billing_date) {
    return null;
  }

  const invoice = await createInvoiceIfMissing(connection, plan, plan.next_billing_date);
  const nextBillingDate = getNextBillingDate(
    plan.next_billing_date,
    plan.billing_cycle,
    plan.frequency
  );

  await connection.query(
    `UPDATE customer_plans
     SET next_billing_date = ?
     WHERE id = ?`,
    [nextBillingDate, plan.id]
  );

  return invoice;
}

async function ensureInvoicesForCompletedServices(connection, customerId) {
  const [[plan]] = await connection.query(
    `SELECT *
     FROM customer_plans
     WHERE customer_id = ? AND status = 'active'
     ORDER BY id DESC
     LIMIT 1`,
    [customerId]
  );

  if (!plan || plan.billing_cycle === "one_time") {
    return [];
  }

  const completedVisits = await getCompletedVisitCountForPlan(connection, plan);
  const visitsPerCycle = getVisitsPerBillingCycle(
    plan.frequency,
    plan.billing_cycle
  );
  const requiredInvoiceCount = Math.max(
    1,
    Math.ceil(completedVisits / visitsPerCycle)
  );

  const [existingInvoices] = await connection.query(
    `SELECT *
     FROM invoices
     WHERE customer_plan_id = ?
     ORDER BY invoice_month ASC, id ASC`,
    [plan.id]
  );

  if (existingInvoices.length >= requiredInvoiceCount) {
    return [];
  }

  const createdInvoices = [];
  let invoiceDate = plan.start_date;

  for (let index = 0; index < requiredInvoiceCount; index += 1) {
    if (index >= existingInvoices.length) {
      const invoice = await createInvoiceIfMissing(connection, plan, invoiceDate);
      createdInvoices.push(invoice);
    }

    invoiceDate = getNextBillingDate(
      invoiceDate,
      plan.billing_cycle,
      plan.frequency
    );
  }

  const currentNextBillingDate = parseDateValue(plan.next_billing_date);
  const ensuredNextBillingDate = parseDateValue(invoiceDate);

  if (
    ensuredNextBillingDate &&
    (!currentNextBillingDate || ensuredNextBillingDate > currentNextBillingDate)
  ) {
    await connection.query(
      `UPDATE customer_plans
       SET next_billing_date = ?
       WHERE id = ?`,
      [invoiceDate, plan.id]
    );
  }

  return createdInvoices;
}

async function recalculateInvoice(connection, invoiceId) {
  const [[invoice]] = await connection.query(
    `SELECT i.*, cp.billing_cycle, cp.next_billing_date, cp.plan_type, cp.frequency, cp.plan_price, cp.status AS plan_status
     FROM invoices i
     JOIN customer_plans cp ON cp.id = i.customer_plan_id
     WHERE i.id = ?
     LIMIT 1`,
    [invoiceId]
  );

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const [[paymentTotals]] = await connection.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid_amount
     FROM payments
     WHERE invoice_id = ?`,
    [invoiceId]
  );

  const paidAmount = Number(paymentTotals.paid_amount || 0);
  const amount = Number(invoice.amount || 0);
  const balance = Math.max(amount - paidAmount, 0);
  const status = getInvoiceStatus({
    paidAmount,
    balance,
    dueDate: invoice.due_date,
  });

  await connection.query(
    `UPDATE invoices
     SET paid_amount = ?,
         balance = ?,
         status = ?
     WHERE id = ?`,
    [paidAmount, balance, status, invoiceId]
  );

  if (status === "paid") {
    await createNextInvoiceForPlan(connection, {
      id: invoice.customer_plan_id,
      customer_id: invoice.customer_id,
      billing_cycle: invoice.billing_cycle,
      next_billing_date: invoice.next_billing_date,
      plan_type: invoice.plan_type,
      frequency: invoice.frequency,
      plan_price: invoice.plan_price,
      status: invoice.plan_status,
    });
  }

  const [[updatedInvoice]] = await connection.query(
    "SELECT * FROM invoices WHERE id = ? LIMIT 1",
    [invoiceId]
  );

  return updatedInvoice;
}

async function getOldestOpenInvoiceForPlan(connection, planId) {
  const [rows] = await connection.query(
    `SELECT *
     FROM invoices
     WHERE customer_plan_id = ?
       AND balance > 0
     ORDER BY invoice_month ASC, id ASC
     LIMIT 1`,
    [planId]
  );

  return rows[0] || null;
}

async function getPlanById(connection, planId) {
  const [[plan]] = await connection.query(
    "SELECT * FROM customer_plans WHERE id = ? LIMIT 1",
    [planId]
  );

  return plan || null;
}

async function recordPayment(connection, invoiceId, payment, options = {}) {
  const [[invoice]] = await connection.query(
    "SELECT * FROM invoices WHERE id = ? LIMIT 1",
    [invoiceId]
  );

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const amount = Number(payment.amount || 0);

  if (amount <= 0) {
    const error = new Error("Payment amount must be greater than 0");
    error.statusCode = 400;
    throw error;
  }

  if (!options.allowUpcoming) {
    const [planInvoices] = await connection.query(
      `SELECT
          i.*,
          cp.plan_type,
          cp.frequency,
          cp.billing_cycle,
          cp.start_date
       FROM invoices i
       JOIN customer_plans cp ON cp.id = i.customer_plan_id
       WHERE i.customer_plan_id = ?`,
      [invoice.customer_plan_id]
    );
    const decoratedInvoices = await decorateInvoicesForCollection(
      connection,
      planInvoices
    );
    const decoratedInvoice = decoratedInvoices.find(
      (item) => Number(item.id) === Number(invoice.id)
    );

    if (Number(decoratedInvoice?.is_collectible || 0) !== 1) {
      const error = new Error("This invoice is not collectible yet");
      error.statusCode = 400;
      throw error;
    }
  }

  if (amount > Number(invoice.balance || 0)) {
    const error = new Error("Payment amount cannot be greater than invoice balance");
    error.statusCode = 400;
    throw error;
  }

  await connection.query(
    `INSERT INTO payments
     (customer_id, invoice_id, amount, payment_date, payment_mode, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      invoice.customer_id,
      invoice.id,
      amount,
      payment.payment_date || formatDate(new Date()),
      payment.payment_mode || null,
      payment.notes || null,
    ]
  );

  return recalculateInvoice(connection, invoice.id);
}

async function applyPaymentAcrossPlanInvoices(connection, planId, firstInvoice, payment) {
  let remaining = Number(payment.amount || 0);

  if (remaining <= 0) {
    return;
  }

  let plan = await getPlanById(connection, planId);
  let invoice = firstInvoice;

  for (let attempts = 0; remaining > 0 && attempts < 120; attempts += 1) {
    if (!invoice || Number(invoice.balance || 0) <= 0) {
      invoice = await getOldestOpenInvoiceForPlan(connection, planId);
    }

    if (!invoice || Number(invoice.balance || 0) <= 0) {
      if (!plan || plan.billing_cycle === "one_time") {
        break;
      }

      invoice = await createNextInvoiceForPlan(connection, plan);
      plan = await getPlanById(connection, planId);
    }

    if (!invoice || Number(invoice.balance || 0) <= 0) {
      break;
    }

    const appliedAmount = Math.min(remaining, Number(invoice.balance || 0));
    await recordPayment(
      connection,
      invoice.id,
      {
        ...payment,
        amount: appliedAmount,
      },
      { allowUpcoming: true }
    );

    remaining -= appliedAmount;
    plan = await getPlanById(connection, planId);
    invoice = await getOldestOpenInvoiceForPlan(connection, planId);
  }

  if (remaining > 0) {
    const error = new Error("Advance payment cannot be fully applied to available billing cycles");
    error.statusCode = 400;
    throw error;
  }
}

async function createPlanAndInitialInvoice(connection, customer, initialPayment = null) {
  const billingCycle = getBillingCycle(customer.plan_type);
  const startDate = customer.start_date || formatDate(new Date());
  const nextBillingDate = getNextBillingDate(
    startDate,
    billingCycle,
    customer.frequency
  );

  const [planResult] = await connection.query(
    `INSERT INTO customer_plans
     (customer_id, plan_type, frequency, plan_price, billing_cycle, start_date, next_billing_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      customer.id,
      customer.plan_type,
      customer.frequency,
      customer.plan_price,
      billingCycle,
      startDate,
      nextBillingDate,
    ]
  );

  const [[plan]] = await connection.query(
    "SELECT * FROM customer_plans WHERE id = ? LIMIT 1",
    [planResult.insertId]
  );
  const invoice = await createInvoiceIfMissing(connection, plan, startDate);

  if (initialPayment && Number(initialPayment.amount || 0) > 0) {
    await applyPaymentAcrossPlanInvoices(connection, plan.id, invoice, initialPayment);
  }

  return plan;
}

async function renewPaidPlanForNextCycle(connection, customer, renewalDate) {
  const [plans] = await connection.query(
    `SELECT *
     FROM customer_plans
     WHERE customer_id = ? AND status = 'active'
     ORDER BY id DESC
     LIMIT 1`,
    [customer.id]
  );

  if (!plans.length) {
    return null;
  }

  const plan = plans[0];

  if (plan.billing_cycle === "one_time") {
    return null;
  }

  const startDate = renewalDate || formatDate(new Date());
  const nextBillingDate = getNextBillingDate(
    startDate,
    plan.billing_cycle,
    plan.frequency
  );

  await connection.query(
    `UPDATE customer_plans
     SET status = 'expired'
     WHERE id = ?`,
    [plan.id]
  );

  const [planResult] = await connection.query(
    `INSERT INTO customer_plans
     (customer_id, plan_type, frequency, plan_price, billing_cycle, start_date, next_billing_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      customer.id,
      plan.plan_type,
      plan.frequency,
      plan.plan_price,
      plan.billing_cycle,
      startDate,
      nextBillingDate,
    ]
  );

  const [[newPlan]] = await connection.query(
    "SELECT * FROM customer_plans WHERE id = ? LIMIT 1",
    [planResult.insertId]
  );
  const invoice = await createInvoiceIfMissing(connection, newPlan, startDate);

  await connection.query(
    `UPDATE customers
     SET start_date = ?,
         advance_paid = 0,
         balance = ?
     WHERE id = ?`,
    [startDate, Number(plan.plan_price || 0), customer.id]
  );

  return {
    invoice,
    plan: newPlan,
  };
}

async function renewPaidCompletedPlanIfNeeded(connection, customerId, renewalDate) {
  const [[customer]] = await connection.query(
    `SELECT id, start_date, frequency
     FROM customers
     WHERE id = ?
     LIMIT 1`,
    [customerId]
  );

  if (!customer || !customer.start_date || !customer.frequency) {
    return null;
  }

  const [[openSummary]] = await connection.query(
    `SELECT COUNT(*) AS open_count
     FROM service_visits
     WHERE customer_id = ?
       AND status NOT IN ('completed', 'skipped')`,
    [customer.id]
  );

  if (Number(openSummary.open_count || 0) > 0) {
    return null;
  }

  const [[activePlan]] = await connection.query(
    `SELECT billing_cycle
     FROM customer_plans
     WHERE customer_id = ? AND status = 'active'
     ORDER BY id DESC
     LIMIT 1`,
    [customer.id]
  );

  if (!activePlan) {
    return null;
  }

  const [[visitCountRow]] = await connection.query(
    `SELECT COUNT(*) AS total_visits
     FROM service_visits
     WHERE customer_id = ?
       AND DATE(COALESCE(next_service_date, visit_date)) >= DATE(?)`,
    [customer.id, customer.start_date]
  );

  const startDate = renewalDate || formatDate(new Date());
  const nextServiceDate = calculateNextServiceDate(startDate, customer.frequency);
  const canContinueCurrentPlan = canScheduleAnotherVisit({
    frequency: customer.frequency,
    startDate: customer.start_date,
    totalVisits: Number(visitCountRow.total_visits || 0),
    candidateDate: nextServiceDate,
  });

  if (canContinueCurrentPlan && activePlan.billing_cycle !== "one_time") {
    return null;
  }

  const renewal = await renewPaidPlanForNextCycle(connection, customer, startDate);

  if (!renewal) {
    return null;
  }

  await connection.query(
    `INSERT INTO service_visits
     (customer_id, visit_date, status, next_service_date, reminder_sent)
     VALUES (?, ?, 'pending', ?, 0)`,
    [customer.id, null, nextServiceDate]
  );

  await connection.query(
    `UPDATE customers
     SET next_service_date = ?
     WHERE id = ?`,
    [nextServiceDate, customer.id]
  );

  return {
    ...renewal,
    next_service_date: nextServiceDate,
  };
}

async function syncActivePlanFromCustomer(connection, customer) {
  const [plans] = await connection.query(
    `SELECT *
     FROM customer_plans
     WHERE customer_id = ? AND status = 'active'
     ORDER BY id DESC
     LIMIT 1`,
    [customer.id]
  );

  if (!plans.length) {
    return createPlanAndInitialInvoice(connection, customer);
  }

  const plan = plans[0];
  const billingCycle = getBillingCycle(customer.plan_type);

  if (hasPlanBillingChange(plan, customer)) {
    await connection.query(
      `UPDATE customer_plans
       SET status = 'expired'
       WHERE id = ?`,
      [plan.id]
    );

    const newPlan = await createPlanAndInitialInvoice(connection, customer);

    await connection.query(
      `UPDATE customers
       SET advance_paid = 0,
           balance = ?
       WHERE id = ?`,
      [Number(customer.plan_price || 0), customer.id]
    );

    return newPlan;
  }

  await connection.query(
    `UPDATE customer_plans
     SET plan_type = ?,
         frequency = ?,
         plan_price = ?,
         billing_cycle = ?,
         start_date = ?
     WHERE id = ?`,
    [
      customer.plan_type,
      customer.frequency,
      customer.plan_price,
      billingCycle,
      customer.start_date,
      plan.id,
    ]
  );

  return plan;
}

async function withTransaction(callback) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  createPlanAndInitialInvoice,
  decorateInvoicesForCollection,
  ensureInvoicesForCompletedServices,
  formatDate,
  getCustomerBillingSummary,
  getBillingCycle,
  getInvoiceStatus,
  recordPayment,
  recalculateInvoice,
  renewPaidCompletedPlanIfNeeded,
  renewPaidPlanForNextCycle,
  syncActivePlanFromCustomer,
  withTransaction,
};
