const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");
const {
  calculateNextServiceDate,
  canScheduleAnotherVisit,
} = require("../utils/serviceSchedule");
const {
  ensureInvoicesForCompletedServices,
  formatDate,
  renewPaidPlanForNextCycle,
} = require("../services/billing.service");

exports.getAllVisits = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    const search = req.query.search || "";
    const area = req.query.area || "";
    const status = req.query.status || "pending";
    const orderDirection = status === "all" ? "DESC" : "ASC";

    let where = "WHERE c.user_id = ?";
    const params = [userId];

    if (status === "all") {
      where += " AND sv.status IN ('pending', 'completed')";
    } else if (status === "overdue") {
      where += " AND sv.status = 'pending' AND DATE(sv.next_service_date) < CURDATE()";
    } else if (status === "pending") {
      where += " AND sv.status = 'pending' AND DATE(sv.next_service_date) >= CURDATE()";
    } else if (status) {
      where += " AND sv.status = ?";
      params.push(status);
    }

    if (search) {
      where += " AND (c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
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
          c.area,
          c.address,
          c.plan_type,
          CASE
            WHEN sv.status = 'pending' AND DATE(sv.next_service_date) < CURDATE()
            THEN 1
            ELSE 0
          END AS is_overdue
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       ${where}
       ORDER BY sv.next_service_date ${orderDirection}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      total: countRows[0].total,
      page,
      limit,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching visits",
    });
  }
};

exports.generateVisitsFromCustomers = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = requireAuthenticatedUserId(req);
    const customerId = req.body.customer_id || req.query.customer_id || null;

    let customerWhere = `
      WHERE c.user_id = ?
        AND COALESCE(c.customer_type, 'customer') = 'customer'
        AND c.start_date IS NOT NULL
        AND c.frequency IS NOT NULL
    `;
    const customerParams = [userId];

    if (customerId) {
      customerWhere += " AND c.id = ?";
      customerParams.push(customerId);
    }

    const [customers] = await connection.query(
      `SELECT
          c.id,
          c.name,
          c.start_date,
          c.next_service_date,
          c.frequency,
          COUNT(
            CASE
              WHEN DATE(COALESCE(sv.next_service_date, sv.visit_date)) >= DATE(c.start_date)
              THEN sv.id
              ELSE NULL
            END
          ) AS total_visits,
          SUM(CASE WHEN sv.status NOT IN ('completed', 'skipped') THEN 1 ELSE 0 END) AS open_visits
       FROM customers c
       LEFT JOIN service_visits sv ON sv.customer_id = c.id
       ${customerWhere}
       GROUP BY c.id, c.name, c.start_date, c.next_service_date, c.frequency
       ORDER BY c.id ASC`,
      customerParams
    );

    if (!customers.length) {
      return res.status(404).json({
        message: customerId
          ? "Customer not found or not eligible for scheduling"
          : "No eligible customers found",
      });
    }

    await connection.beginTransaction();

    const summary = {
      inserted: 0,
      skipped_existing_open_visit: 0,
      skipped_missing_next_service_date: 0,
      skipped_plan_limit_reached: 0,
      customers: [],
    };

    for (const customer of customers) {
      if (Number(customer.open_visits || 0) > 0) {
        summary.skipped_existing_open_visit += 1;
        summary.customers.push({
          customer_id: customer.id,
          name: customer.name,
          action: "skipped_existing_open_visit",
          next_service_date: customer.next_service_date,
        });
        continue;
      }

      const [latestVisitRows] = await connection.query(
        `SELECT id, status, next_service_date
         FROM service_visits
         WHERE customer_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [customer.id]
      );

      const latestVisit = latestVisitRows[0] || null;
      let scheduledDate = null;

      if (latestVisit?.status === "completed" && latestVisit.next_service_date) {
        scheduledDate = calculateNextServiceDate(
          latestVisit.next_service_date,
          customer.frequency
        );
      } else if (customer.next_service_date) {
        scheduledDate = customer.next_service_date;
      } else if (customer.start_date) {
        scheduledDate = calculateNextServiceDate(
          customer.start_date,
          customer.frequency
        );
      }

      if (!scheduledDate) {
        summary.skipped_missing_next_service_date += 1;
        summary.customers.push({
          customer_id: customer.id,
          name: customer.name,
          action: "skipped_missing_next_service_date",
        });
        continue;
      }

      const allowed = canScheduleAnotherVisit({
        frequency: customer.frequency,
        startDate: customer.start_date,
        totalVisits: Number(customer.total_visits || 0),
        candidateDate: scheduledDate,
      });

      if (!allowed) {
        await connection.query(
          `UPDATE customers
           SET next_service_date = NULL
           WHERE id = ? AND user_id = ?`,
          [customer.id, userId]
        );

        summary.skipped_plan_limit_reached += 1;
        summary.customers.push({
          customer_id: customer.id,
          name: customer.name,
          action: "skipped_plan_limit_reached",
        });
        continue;
      }

      await connection.query(
        `INSERT INTO service_visits
         (customer_id, visit_date, status, next_service_date, reminder_sent)
         VALUES (?, ?, 'pending', ?, 0)`,
        [customer.id, null, scheduledDate]
      );
      await connection.query(
        `UPDATE customers
         SET next_service_date = ?
         WHERE id = ? AND user_id = ?`,
        [scheduledDate, customer.id, userId]
      );

      summary.inserted += 1;
      summary.customers.push({
        customer_id: customer.id,
        name: customer.name,
        action: "inserted",
        next_service_date: scheduledDate,
      });
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Service visits generated from customers",
      ...summary,
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Failed to generate service visits",
    });
  } finally {
    connection.release();
  }
};

exports.createServiceVisit = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { customer_id, next_service_date } = req.body;

    const [[customer]] = await db.query(
      "SELECT id FROM customers WHERE id = ? AND user_id = ? LIMIT 1",
      [customer_id, userId]
    );

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    await db.query(
      `INSERT INTO service_visits
       (customer_id, next_service_date, reminder_sent)
       VALUES (?, ?, 0)`,
      [customer_id, next_service_date]
    );

    res.json({ success: true, message: "Service visit created" });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to create service visit",
    });
  }
};

exports.completeService = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;

    await connection.beginTransaction();

    const [visits] = await connection.query(
      `SELECT sv.*
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.id = ? AND c.user_id = ?`,
      [id, userId]
    );

    if (!visits.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Visit not found" });
    }

    const visit = visits[0];

    if (visit.status === "completed") {
      await connection.rollback();
      return res.status(400).json({ message: "Already completed" });
    }

    const [customers] = await connection.query(
      `SELECT * FROM customers WHERE id = ? AND user_id = ?`,
      [visit.customer_id, userId]
    );

    const customer = customers[0];
    const completedDate = formatDate(new Date());
    await connection.query(
      `UPDATE service_visits
       SET status = 'completed',
           visit_date = ?
       WHERE id = ?`,
      [completedDate, id]
    );
    const generatedBillingInvoices = await ensureInvoicesForCompletedServices(
      connection,
      customer.id
    );

    const nextDate = calculateNextServiceDate(
      visit.next_service_date || completedDate,
      customer.frequency
    );
    const [[visitCountRow]] = await connection.query(
      `SELECT COUNT(*) AS total_visits
       FROM service_visits
       WHERE customer_id = ?
         AND DATE(COALESCE(next_service_date, visit_date)) >= DATE(?)`,
      [customer.id, customer.start_date]
    );

    const [openRows] = await connection.query(
      `SELECT id, next_service_date
       FROM service_visits
       WHERE customer_id = ?
         AND status NOT IN ('completed', 'skipped')
       ORDER BY next_service_date ASC, id ASC
       LIMIT 1`,
      [customer.id]
    );

    const shouldCreateNextVisit =
      !openRows.length &&
      canScheduleAnotherVisit({
        frequency: customer.frequency,
        startDate: customer.start_date,
        totalVisits: Number(visitCountRow.total_visits || 0),
        candidateDate: nextDate,
      });

    if (shouldCreateNextVisit) {
      await connection.query(
        `INSERT INTO service_visits
         (customer_id, visit_date, status, next_service_date, reminder_sent)
         VALUES (?, ?, 'pending', ?, 0)`,
        [customer.id, null, nextDate]
      );
    }

    let renewedBilling = null;
    let nextServiceDate = shouldCreateNextVisit
      ? nextDate
      : openRows[0]?.next_service_date || null;

    if (!openRows.length && !shouldCreateNextVisit) {
      renewedBilling = await renewPaidPlanForNextCycle(
        connection,
        customer,
        completedDate
      );

      if (renewedBilling) {
        nextServiceDate = calculateNextServiceDate(
          completedDate,
          customer.frequency
        );

        await connection.query(
          `INSERT INTO service_visits
           (customer_id, visit_date, status, next_service_date, reminder_sent)
           VALUES (?, ?, 'pending', ?, 0)`,
          [customer.id, null, nextServiceDate]
        );
      }
    }

    await connection.query(
      `UPDATE customers
       SET next_service_date = ?
       WHERE id = ? AND user_id = ?`,
      [nextServiceDate, customer.id, userId]
    );

    await connection.commit();

    res.json({
      success: true,
      message:
        shouldCreateNextVisit || renewedBilling
          ? "Service completed and next visit scheduled"
          : "Service completed and plan limit reached",
      next_service_date: nextServiceDate,
      generated_billing_invoices: generatedBillingInvoices,
      renewal_invoice: renewedBilling?.invoice || null,
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to complete service",
    });
  } finally {
    connection.release();
  }
};

exports.rescheduleService = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;
    const { next_service_date } = req.body;

    if (!next_service_date) {
      return res.status(400).json({ message: "Date is required" });
    }

    const [visits] = await db.query(
      `SELECT sv.*
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.id = ? AND c.user_id = ?`,
      [id, userId]
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

    await db.query(
      `UPDATE service_visits
       SET next_service_date = ?
       WHERE id = ?`,
      [next_service_date, id]
    );

    await db.query(
      `UPDATE customers
       SET next_service_date = ?
       WHERE id = ? AND user_id = ?`,
      [next_service_date, visit.customer_id, userId]
    );

    res.json({
      success: true,
      message: "Service rescheduled successfully",
      next_service_date,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to reschedule service",
    });
  }
};

exports.deleteServiceVisit = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = requireAuthenticatedUserId(req);
    const { id } = req.params;

    await connection.beginTransaction();

    const [visits] = await connection.query(
      `SELECT sv.id, sv.customer_id
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.id = ? AND c.user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!visits.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Visit not found" });
    }

    const visit = visits[0];

    await connection.query("DELETE FROM service_visits WHERE id = ?", [id]);

    const [openRows] = await connection.query(
      `SELECT next_service_date
       FROM service_visits
       WHERE customer_id = ?
         AND status NOT IN ('completed', 'skipped')
       ORDER BY next_service_date ASC, id ASC
       LIMIT 1`,
      [visit.customer_id]
    );

    const nextServiceDate = openRows[0]?.next_service_date || null;

    await connection.query(
      `UPDATE customers
       SET next_service_date = ?
       WHERE id = ? AND user_id = ?`,
      [nextServiceDate, visit.customer_id, userId]
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Service visit deleted",
      next_service_date: nextServiceDate,
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to delete service visit",
    });
  } finally {
    connection.release();
  }
};

exports.createPlanVisits = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { customer_id, visits, interval_days } = req.body;

    const [[customer]] = await db.query(
      "SELECT id FROM customers WHERE id = ? AND user_id = ? LIMIT 1",
      [customer_id, userId]
    );

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    for (let i = 1; i <= visits; i += 1) {
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + i * interval_days);

      await db.query(
        `INSERT INTO service_visits
         (customer_id, next_service_date, reminder_sent)
         VALUES (?, ?, 0)`,
        [customer_id, nextDate]
      );
    }

    res.json({ success: true, message: "Plan visits scheduled" });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to create plan visits",
    });
  }
};

exports.getServiceVisits = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { customer_id } = req.params;

    const [rows] = await db.query(
      `SELECT sv.*
            ,
            CASE
              WHEN sv.status = 'pending' AND DATE(sv.next_service_date) < CURDATE()
              THEN 1
              ELSE 0
            END AS is_overdue
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.customer_id = ? AND c.user_id = ?
       ORDER BY sv.next_service_date ASC`,
      [customer_id, userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to fetch visits",
    });
  }
};
