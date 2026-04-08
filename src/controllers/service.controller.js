const db = require("../config/db");

exports.getAllVisits = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    const search = req.query.search || "";
    const area = req.query.area || "";
    const status = req.query.status || "pending";

    let where = "WHERE sv.status = ?";
    let params = [status];

    if (search) {
      where += " AND (c.name LIKE ? OR c.phone LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    if (area) {
      where += " AND c.area = ?";
      params.push(area);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) as total
             FROM service_visits sv
             JOIN customers c ON c.id = sv.customer_id
             ${where}`,
      params
    );

    const [rows] = await db.query(
      `SELECT 
                sv.*,
                c.name,
                c.phone,
                c.area
             FROM service_visits sv
             JOIN customers c ON c.id = sv.customer_id
             ${where}
             ORDER BY sv.next_service_date ASC
             LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      total: countRows[0].total,
      page,
      limit,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching visits" });
  }
};

// ✅ 1. CREATE SINGLE SERVICE VISIT (manual/admin)
exports.createServiceVisit = async (req, res) => {
  try {
    const { customer_id, next_service_date } = req.body;

    await db.query(
      `INSERT INTO service_visits 
       (customer_id, next_service_date, reminder_sent) 
       VALUES (?, ?, 0)`,
      [customer_id, next_service_date]
    );

    res.json({ success: true, message: "Service visit created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create service visit" });
  }
};


// ✅ 2. COMPLETE SERVICE → AUTO CREATE NEXT VISIT
exports.completeService = async (req, res) => {
  try {
    const { id } = req.params; // service_visit_id

    // 1. Get visit
    const [visits] = await db.query(
      `SELECT * FROM service_visits WHERE id = ?`,
      [id]
    );

    if (!visits.length) {
      return res.status(404).json({ message: "Visit not found" });
    }

    const visit = visits[0];

    if (visit.status === "completed") {
      return res.status(400).json({ message: "Already completed" });
    }

    // 2. Get customer
    const [customers] = await db.query(
      `SELECT * FROM customers WHERE id = ?`,
      [visit.customer_id]
    );

    const customer = customers[0];

    // 3. Mark visit completed
    await db.query(
      `UPDATE service_visits
       SET status = 'completed',
           visit_date = NOW()
       WHERE id = ?`,
      [id]
    );

    // 4. Calculate next date
    const nextDate = new Date(visit.next_service_date);

    switch (customer.frequency) {
      case "Monthly":
        nextDate.setMonth(nextDate.getMonth() + 1);
        break;
      case "1/Month":
        nextDate.setDate(nextDate.getDate() + 30);
        break;
      case "2/Month":
      case "24/Year":
        nextDate.setDate(nextDate.getDate() + 15);
        break;
      default:
        throw new Error("Invalid frequency");
    }

    // 5. Insert next visit
    await db.query(
      `INSERT INTO service_visits
       (customer_id, visit_date, status, next_service_date, reminder_sent)
       VALUES (?, ?, 'pending', ?, 0)`,
      [customer.id, nextDate, nextDate]
    );

    // 6. Update customer
    await db.query(
      `UPDATE customers
       SET next_service_date = ?
       WHERE id = ?`,
      [nextDate, customer.id]
    );

    res.json({
      success: true,
      message: "Service completed & next visit scheduled",
      next_service_date: nextDate,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to complete service" });
  }
};

// ✅ RESCHEDULE SERVICE
exports.rescheduleService = async (req, res) => {
  try {
    const { id } = req.params; // service_visit_id
    const { next_service_date } = req.body;

    if (!next_service_date) {
      return res.status(400).json({ message: "Date is required" });
    }

    // 1. Get visit
    const [visits] = await db.query(
      `SELECT * FROM service_visits WHERE id = ?`,
      [id]
    );

    if (!visits.length) {
      return res.status(404).json({ message: "Visit not found" });
    }

    const visit = visits[0];

    if (visit.status === "completed") {
      return res.status(400).json({
        message: "Cannot reschedule completed visit",
      });
    }

    // 2. Update service_visits
    await db.query(
      `UPDATE service_visits
       SET next_service_date = ?,
           visit_date = ?
       WHERE id = ?`,
      [next_service_date, next_service_date, id]
    );

    // 3. Update customer
    await db.query(
      `UPDATE customers
       SET next_service_date = ?
       WHERE id = ?`,
      [next_service_date, visit.customer_id]
    );

    res.json({
      success: true,
      message: "Service rescheduled successfully",
      next_service_date,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reschedule service" });
  }
};

// ✅ 3. CREATE PLAN VISITS (AUTO SCHEDULING 🔥)
exports.createPlanVisits = async (req, res) => {
  try {
    const { customer_id, visits, interval_days } = req.body;

    for (let i = 1; i <= visits; i++) {
      let nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + i * interval_days);

      await db.query(
        `INSERT INTO service_visits 
         (customer_id, next_service_date, reminder_sent) 
         VALUES (?, ?, 0)`,
        [customer_id, nextDate]
      );
    }

    res.json({ success: true, message: "Plan visits scheduled" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create plan visits" });
  }
};

// ✅ 4. GET SERVICE VISITS (for UI)
exports.getServiceVisits = async (req, res) => {
  try {
    const { customer_id } = req.params;

    const [rows] = await db.query(
      `SELECT * FROM service_visits 
       WHERE customer_id = ? 
       ORDER BY next_service_date ASC`,
      [customer_id]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch visits" });
  }
};