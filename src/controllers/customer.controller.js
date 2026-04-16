const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");
const { calculateNextServiceDate } = require("../utils/serviceSchedule");

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

    let where = "WHERE user_id = ?";
    const params = [userId];

    if (search) {
      where += " AND (name LIKE ? OR phone LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    if (area) {
      where += " AND area = ?";
      params.push(area);
    }

    if (plan) {
      where += " AND plan_type = ?";
      params.push(plan);
    }

    if (type) {
      where += " AND customer_category = ?";
      params.push(type);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) as total FROM customers ${where}`,
      params
    );
    const total = countRows[0].total;

    const [rows] = await db.query(
      `SELECT * FROM customers
       ${where}
       ORDER BY id DESC
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
      start_date,
      frequency,
      customer_type,
    } = req.body;

    const balance = Number(plan_price) - Number(advance_paid || 0);
    const next_service_date = calculateNextServiceDate(start_date, frequency);

    const [result] = await connection.query(
      `INSERT INTO customers
       (user_id, whatsapp_account_id, name, phone, address, area, plan_type, plan_price, advance_paid, balance, start_date, next_service_date, frequency, customer_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        balance,
        start_date,
        next_service_date,
        frequency,
        customer_type,
      ]
    );

    const customerId = result.insertId;

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
  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;
    const {
      name,
      phone,
      address,
      area,
      plan_type,
      plan_price,
      advance_paid,
      start_date,
      frequency,
      customer_type,
      notes,
    } = req.body;

    const balance = Number(plan_price) - Number(advance_paid || 0);
    const next_service_date = calculateNextServiceDate(start_date, frequency);

    const [customerResult] = await db.query(
      `UPDATE customers SET
         name = ?,
         phone = ?,
         address = ?,
         area = ?,
         plan_type = ?,
         plan_price = ?,
         advance_paid = ?,
         balance = ?,
         start_date = ?,
         next_service_date = ?,
         frequency = ?,
         customer_type = ?,
         notes = ?
       WHERE id = ? AND user_id = ?`,
      [
        name,
        phone,
        address,
        area,
        plan_type,
        plan_price,
        advance_paid,
        balance,
        start_date,
        next_service_date,
        frequency,
        customer_type,
        notes || null,
        id,
        userId,
      ]
    );

    if (customerResult.affectedRows === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }

    await db.query(
      `UPDATE service_visits
       SET next_service_date = ?
       WHERE customer_id = ?
       AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
      [next_service_date, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("UPDATE ERROR:", error);
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
