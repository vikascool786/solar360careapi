const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");
const {
  decorateInvoicesForCollection,
  formatDate,
  recordPayment,
  renewPaidCompletedPlanIfNeeded,
  withTransaction,
} = require("../services/billing.service");

async function markOverdueInvoices(userId) {
  await db.query(
    `UPDATE invoices i
     JOIN customers c ON c.id = i.customer_id
     SET i.status = 'overdue'
     WHERE c.user_id = ?
       AND i.balance > 0
       AND i.due_date < CURDATE()
       AND i.status IN ('pending', 'partial')`,
    [userId]
  );
}

exports.getInvoices = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    await markOverdueInvoices(userId);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || "";
    const customerId = req.query.customer_id || "";

    let where = "WHERE c.user_id = ?";
    const params = [userId];

    if (status) {
      where += " AND i.status = ?";
      params.push(status);
    }

    if (customerId) {
      where += " AND i.customer_id = ?";
      params.push(customerId);
    }

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN customer_plans cp ON cp.id = i.customer_plan_id
       ${where}`,
      params
    );

    const [rows] = await db.query(
      `SELECT
          i.*,
          c.name,
          c.phone,
          c.area,
          cp.plan_type,
          cp.frequency,
          cp.billing_cycle,
          cp.start_date
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN customer_plans cp ON cp.id = i.customer_plan_id
       ${where}
       ORDER BY i.due_date DESC, i.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const data = await decorateInvoicesForCollection(db, rows);

    res.json({
      data,
      total: countRow.total,
      page,
      limit,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching invoices",
    });
  }
};

exports.getCustomerInvoices = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    await markOverdueInvoices(userId);
    const { customer_id } = req.params;

    const [rows] = await db.query(
      `SELECT
          i.*,
          cp.plan_type,
          cp.frequency,
          cp.billing_cycle,
          cp.start_date
       FROM invoices i
       JOIN customer_plans cp ON cp.id = i.customer_plan_id
       JOIN customers c ON c.id = i.customer_id
       WHERE i.customer_id = ? AND c.user_id = ?
       ORDER BY i.due_date DESC, i.id DESC`,
      [customer_id, userId]
    );

    const data = await decorateInvoicesForCollection(db, rows);

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching customer invoices",
    });
  }
};

exports.getInvoicePayments = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { invoice_id } = req.params;

    const [rows] = await db.query(
      `SELECT p.*
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN customers c ON c.id = i.customer_id
       WHERE p.invoice_id = ? AND c.user_id = ?
       ORDER BY p.payment_date DESC, p.id DESC`,
      [invoice_id, userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching payments",
    });
  }
};

exports.addPayment = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { invoice_id } = req.params;
    const { amount, payment_date, payment_mode, notes } = req.body;

    const [[invoice]] = await db.query(
      `SELECT i.id
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.id = ? AND c.user_id = ?
       LIMIT 1`,
      [invoice_id, userId]
    );

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const paymentDate = payment_date || formatDate(new Date());
    const result = await withTransaction(async (connection) => {
      const updatedInvoice = await recordPayment(connection, invoice_id, {
        amount,
        payment_date: paymentDate,
        payment_mode,
        notes,
      });
      const renewal = await renewPaidCompletedPlanIfNeeded(
        connection,
        updatedInvoice.customer_id,
        paymentDate
      );

      return {
        invoice: updatedInvoice,
        renewal,
      };
    });

    res.json({
      success: true,
      invoice: result.invoice,
      renewal_invoice: result.renewal?.invoice || null,
      next_service_date: result.renewal?.next_service_date || null,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error adding payment",
    });
  }
};
