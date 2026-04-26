const db = require("../config/db");

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

function getNextBillingDate(dateValue, billingCycle) {
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

function isDueTodayOrEarlier(dateValue) {
  const date = parseDateValue(dateValue);
  const today = parseDateValue(formatDate(new Date()));

  return date && !Number.isNaN(date.getTime()) && date <= today;
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
  if (plan.billing_cycle === "one_time" || !plan.next_billing_date) {
    return null;
  }

  if (!isDueTodayOrEarlier(plan.next_billing_date)) {
    return null;
  }

  const invoice = await createInvoiceIfMissing(connection, plan, plan.next_billing_date);
  const nextBillingDate = getNextBillingDate(plan.next_billing_date, plan.billing_cycle);

  await connection.query(
    `UPDATE customer_plans
     SET next_billing_date = ?
     WHERE id = ?`,
    [nextBillingDate, plan.id]
  );

  return invoice;
}

async function recalculateInvoice(connection, invoiceId) {
  const [[invoice]] = await connection.query(
    `SELECT i.*, cp.billing_cycle, cp.next_billing_date, cp.plan_type, cp.frequency, cp.plan_price
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
    });
  }

  const [[updatedInvoice]] = await connection.query(
    "SELECT * FROM invoices WHERE id = ? LIMIT 1",
    [invoiceId]
  );

  return updatedInvoice;
}

async function recordPayment(connection, invoiceId, payment) {
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

async function createPlanAndInitialInvoice(connection, customer, initialPayment = null) {
  const billingCycle = getBillingCycle(customer.plan_type);
  const startDate = customer.start_date || formatDate(new Date());
  const nextBillingDate = getNextBillingDate(startDate, billingCycle);

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
    await recordPayment(connection, invoice.id, initialPayment);
  }

  return plan;
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
  formatDate,
  getBillingCycle,
  getInvoiceStatus,
  recordPayment,
  recalculateInvoice,
  syncActivePlanFromCustomer,
  withTransaction,
};
