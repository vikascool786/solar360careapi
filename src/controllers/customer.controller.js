const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");
const {
  calculateNextServiceDate,
  normalizeFrequency,
} = require("../utils/serviceSchedule");
const {
  createPlanAndInitialInvoice,
  syncActivePlanFromCustomer,
} = require("../services/billing.service");

function getCustomerCategory(body) {
  const explicitCategory =
    body.customer_category ?? body["customer_category "] ?? null;

  if (explicitCategory) {
    return explicitCategory;
  }

  const rawType = body.customer_type;
  if (rawType && !isValidCustomerType(rawType)) {
    return rawType;
  }

  return null;
}

function resolveCustomerType(body) {
  const rawType = body.customer_type;

  if (rawType && isValidCustomerType(rawType)) {
    return rawType.trim().toLowerCase();
  }

  return "customer";
}

function isValidCustomerType(value) {
  return ["lead", "customer"].includes(String(value).trim().toLowerCase());
}

function hasLocationCoordinates(body) {
  return body.latitude !== undefined && body.longitude !== undefined;
}

exports.getAll = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || "";
    const area = req.query.area || "";
    const plan = req.query.plan || "";
    const type = req.query.type || "";

    const safeLimit = Math.min(limit, 100);
    const offset = (page - 1) * safeLimit;

    let where = "WHERE c.user_id = ?";
    const params = [userId];

    if (search) {
      where += " AND (c.name LIKE ? OR c.phone LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    if (area) {
      where += " AND c.area = ?";
      params.push(area);
    }

    if (plan) {
      where += " AND c.plan_type = ?";
      params.push(plan);
    }

    if (type) {
      where += " AND c.customer_category = ?";
      params.push(type);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) as total FROM customers c ${where}`,
      params
    );
    const total = countRows[0].total;

    const [rows] = await db.query(
      `SELECT
         c.*,
         COALESCE(b.total_balance, 0) AS balance,
         COALESCE(b.total_paid, 0) AS billing_paid_amount,
         COALESCE(b.total_amount, 0) AS billing_total_amount,
         COALESCE(b.total_balance, 0) AS billing_balance,
         b.current_invoice_id,
         b.current_invoice_status,
         b.current_invoice_due_date,
         b.current_invoice_month
       FROM customers c
       LEFT JOIN (
         SELECT
           summary.customer_id,
           SUM(summary.amount) AS total_amount,
           SUM(summary.paid_amount) AS total_paid,
           SUM(summary.balance) AS total_balance,
           (
             SELECT i2.id
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_id,
           (
             SELECT i2.status
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_status,
           (
             SELECT i2.due_date
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_due_date,
           (
             SELECT i2.invoice_month
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_month
         FROM invoices summary
         GROUP BY summary.customer_id
       ) b ON b.customer_id = c.id
       ${where}
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    res.json({
      data: rows,
      total,
      page,
      limit: safeLimit,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  }
};

exports.getById = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;

    const [rows] = await db.query(
      `SELECT
         c.*,
         COALESCE(b.total_balance, 0) AS balance,
         COALESCE(b.total_paid, 0) AS billing_paid_amount,
         COALESCE(b.total_amount, 0) AS billing_total_amount,
         COALESCE(b.total_balance, 0) AS billing_balance,
         b.current_invoice_id,
         b.current_invoice_status,
         b.current_invoice_due_date,
         b.current_invoice_month
       FROM customers c
       LEFT JOIN (
         SELECT
           summary.customer_id,
           SUM(summary.amount) AS total_amount,
           SUM(summary.paid_amount) AS total_paid,
           SUM(summary.balance) AS total_balance,
           (
             SELECT i2.id
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_id,
           (
             SELECT i2.status
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_status,
           (
             SELECT i2.due_date
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_due_date,
           (
             SELECT i2.invoice_month
             FROM invoices i2
             WHERE i2.customer_id = summary.customer_id
             ORDER BY
               CASE WHEN i2.balance > 0 THEN 0 ELSE 1 END,
               i2.due_date ASC,
               i2.id ASC
             LIMIT 1
           ) AS current_invoice_month
         FROM invoices summary
         GROUP BY summary.customer_id
       ) b ON b.customer_id = c.id
       WHERE c.id = ? AND c.user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  }
};

exports.create = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = requireAuthenticatedUserId(req);
    await connection.beginTransaction();

    const {
      whatsapp_account_id = null,
      name,
      phone,
      address,
      area,
      plan_type,
      plan_price,
      advance_paid,
      kw = null,
      start_date,
      frequency: rawFrequency,
      latitude = null,
      longitude = null,
      location_address = null,
    } = req.body;
    const frequency = normalizeFrequency(rawFrequency);
    const customer_type = resolveCustomerType(req.body);
    const customer_category = getCustomerCategory(req.body);
    const shouldSetLocationUpdatedAt = hasLocationCoordinates(req.body);

    const balance = Number(plan_price) - Number(advance_paid || 0);
    const next_service_date = calculateNextServiceDate(start_date, frequency);

    const [result] = await connection.query(
      `INSERT INTO customers
       (user_id, whatsapp_account_id, name, phone, address, area, plan_type, plan_price, advance_paid, kw, balance, start_date, next_service_date, frequency, customer_type, customer_category, latitude, longitude, location_address, location_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${shouldSetLocationUpdatedAt ? "NOW()" : "?"})`,
      [
        userId,
        whatsapp_account_id,
        name,
        phone,
        address,
        area,
        plan_type,
        plan_price,
        advance_paid,
        kw,
        balance,
        start_date,
        next_service_date,
        frequency,
        customer_type,
        customer_category,
        latitude,
        longitude,
        location_address,
        ...(shouldSetLocationUpdatedAt ? [] : [null]),
      ]
    );

    const customerId = result.insertId;
    await createPlanAndInitialInvoice(
      connection,
      {
        id: customerId,
        plan_type,
        frequency,
        plan_price,
        start_date,
      },
      {
        amount: advance_paid,
        payment_date: start_date,
        payment_mode: "advance",
        notes: "Initial advance payment",
      }
    );

    await connection.query(
      `INSERT INTO service_visits
       (customer_id, visit_date, status, next_service_date, reminder_sent)
       VALUES (?, ?, 'completed', ?, 0)`,
      [customerId, start_date, start_date]
    );

    await connection.query(
      `INSERT INTO service_visits
       (customer_id, visit_date, status, next_service_date, reminder_sent)
       VALUES (?, ?, 'pending', ?, 0)`,
      [customerId, null, next_service_date]
    );

    await connection.commit();
    res.json({ success: true, customerId });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  } finally {
    connection.release();
  }
};

exports.update = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = requireAuthenticatedUserId(req);
    await connection.beginTransaction();
    const { id } = req.params;
    const {
      whatsapp_account_id = null,
      name,
      phone,
      address,
      area,
      plan_type,
      plan_price,
      advance_paid,
      kw = null,
      start_date,
      frequency: rawFrequency,
      notes,
      latitude = null,
      longitude = null,
      location_address = null,
    } = req.body;
    const frequency = normalizeFrequency(rawFrequency);
    const customer_type = resolveCustomerType(req.body);
    const customer_category = getCustomerCategory(req.body);
    const shouldSetLocationUpdatedAt = hasLocationCoordinates(req.body);

    const balance = Number(plan_price) - Number(advance_paid || 0);
    const next_service_date = calculateNextServiceDate(start_date, frequency);

    const [customerResult] = await connection.query(
      `UPDATE customers SET
         whatsapp_account_id = ?,
         name = ?,
         phone = ?,
         address = ?,
         area = ?,
         plan_type = ?,
         plan_price = ?,
         advance_paid = ?,
         kw = ?,
         balance = ?,
         start_date = ?,
         next_service_date = ?,
         frequency = ?,
         customer_type = ?,
         customer_category = ?,
         notes = ?,
         latitude = COALESCE(?, latitude),
         longitude = COALESCE(?, longitude),
         location_address = COALESCE(?, location_address),
         location_updated_at = ${shouldSetLocationUpdatedAt ? "NOW()" : "location_updated_at"}
       WHERE id = ? AND user_id = ?`,
      [
        whatsapp_account_id,
        name,
        phone,
        address,
        area,
        plan_type,
        plan_price,
        advance_paid,
        kw,
        balance,
        start_date,
        next_service_date,
        frequency,
        customer_type,
        customer_category,
        notes || null,
        latitude,
        longitude,
        location_address,
        id,
        userId,
      ]
    );

    if (customerResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Customer not found" });
    }

    await syncActivePlanFromCustomer(connection, {
      id,
      plan_type,
      frequency,
      plan_price,
      start_date,
    });

    await connection.query(
      `UPDATE service_visits
       SET next_service_date = ?
       WHERE customer_id = ?
       AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
      [next_service_date, id]
    );

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error("UPDATE ERROR:", error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  } finally {
    connection.release();
  }
};

exports.updateLocation = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;
    const { latitude, longitude, location_address = null } = req.body;

    if (!hasLocationCoordinates(req.body)) {
      return res.status(400).json({
        message: "latitude and longitude are required",
      });
    }

    const [result] = await db.query(
      `UPDATE customers
       SET latitude = ?,
           longitude = ?,
           location_address = ?,
           location_updated_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [latitude, longitude, location_address, id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("LOCATION UPDATE ERROR:", error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  }
};

exports.remove = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;

    const [result] = await db.query(
      "DELETE FROM customers WHERE id = ? AND user_id = ?",
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Server error",
    });
  }
};
