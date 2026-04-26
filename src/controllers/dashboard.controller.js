const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");

async function queryOrFallback(query, params, fallbackQuery, fallbackParams = params) {
  try {
    const [[row]] = await db.query(query, params);
    return row;
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE") {
      throw error;
    }

    const [[fallbackRow]] = await db.query(fallbackQuery, fallbackParams);
    return fallbackRow;
  }
}

exports.getDashboardStats = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);

    const [[totalCustomers]] = await db.query(
      `SELECT COUNT(*) as total FROM customers WHERE user_id = ?`,
      [userId]
    );

    const [[todayServices]] = await db.query(
      `SELECT COUNT(*) as total
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.status = 'pending'
       AND c.user_id = ?
       AND DATE(sv.next_service_date) = CURDATE()`,
      [userId]
    );

    const [[overdueServices]] = await db.query(
      `SELECT COUNT(*) as total
       FROM service_visits sv
       JOIN customers c ON c.id = sv.customer_id
       WHERE sv.status = 'pending'
       AND c.user_id = ?
       AND DATE(sv.next_service_date) < CURDATE()`,
      [userId]
    );

    await db.query(
      `UPDATE invoices i
       JOIN customers c ON c.id = i.customer_id
       SET i.status = 'overdue'
       WHERE c.user_id = ?
         AND i.balance > 0
         AND i.due_date < CURDATE()
         AND i.status IN ('pending', 'partial')`,
      [userId]
    ).catch((error) => {
      if (error.code !== "ER_NO_SUCH_TABLE") {
        throw error;
      }
    });

    const totalIncome = await queryOrFallback(
      `SELECT COALESCE(SUM(p.amount), 0) as total
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       WHERE c.user_id = ?`,
      [userId],
      `SELECT COALESCE(SUM(advance_paid), 0) as total FROM customers WHERE user_id = ?`
    );

    const pendingPayments = await queryOrFallback(
      `SELECT COALESCE(SUM(i.balance), 0) as total
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE c.user_id = ? AND i.balance > 0`,
      [userId],
      `SELECT COALESCE(SUM(balance), 0) as total FROM customers WHERE user_id = ?`
    );

    const [[activeAMCContracts]] = await db.query(
      `SELECT COUNT(*) as total
       FROM customers
       WHERE user_id = ?
       AND plan_type NOT IN ('One Time', 'Monthly')`,
      [userId]
    );

    const [[activeMonthlyContracts]] = await db.query(
      `SELECT COUNT(*) as total
       FROM customers
       WHERE user_id = ?
       AND plan_type = 'Monthly'`,
      [userId]
    );

    const pendingInvoices = await queryOrFallback(
      `SELECT COUNT(*) as total
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE c.user_id = ? AND i.balance > 0`,
      [userId],
      `SELECT COUNT(*) as total
       FROM customers
       WHERE user_id = ? AND balance > 0`
    );

    const [[totalCampaigns]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaigns c
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?`,
      [userId]
    );

    const [[totalSent]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaign_logs cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?
       AND cl.status IN ('sent','delivered','read','replied')`,
      [userId]
    );

    const [[delivered]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaign_logs cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?
       AND cl.status = 'delivered'`,
      [userId]
    );

    const [[read]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaign_logs cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?
       AND cl.status = 'read'`,
      [userId]
    );

    const [[failed]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaign_logs cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?
       AND cl.status = 'failed'`,
      [userId]
    );

    const [[replied]] = await db.query(
      `SELECT COUNT(*) as total
       FROM campaign_logs cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       WHERE wa.user_id = ?
       AND cl.replied = 1`,
      [userId]
    );

    let failedMessages = { total: 0 };

    try {
      const [[failedMessageRows]] = await db.query(
        `SELECT COUNT(*) as total
         FROM messages m
         JOIN customers c ON c.id = m.customer_id
         WHERE c.user_id = ?
         AND m.status = 'failed'`,
        [userId]
      );
      failedMessages = failedMessageRows;
    } catch (error) {
      // ignore if table or column is not ready
    }

    res.json({
      totalCustomers: totalCustomers.total,
      todayServices: todayServices.total,
      overdueServices: overdueServices.total,
      totalIncome: totalIncome.total || 0,
      pendingPayments: pendingPayments.total || 0,
      activeAMCContracts: activeAMCContracts.total,
      activeMonthlyContracts: activeMonthlyContracts.total,
      pendingInvoices: pendingInvoices.total,
      failedMessages: failedMessages.total,
      campaigns: {
        total: totalCampaigns.total,
        sent: totalSent.total,
        delivered: delivered.total,
        read: read.total,
        failed: failed.total,
        replied: replied.total,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching dashboard",
    });
  }
};

exports.getUpcomingServices = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const [rows] = await db.query(
      `
        SELECT
          sv.id,
          sv.next_service_date,
          c.name,
          c.phone
        FROM service_visits sv
        JOIN customers c ON c.id = sv.customer_id
        WHERE sv.status = 'pending'
        AND c.user_id = ?
        ORDER BY sv.next_service_date ASC
        LIMIT 5
      `,
      [userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching upcoming services",
    });
  }
};

exports.getRevenueChart = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    let rows;

    try {
      [rows] = await db.query(
        `
          SELECT
            DATE_FORMAT(p.payment_date, '%b') as month,
            SUM(p.amount) as revenue
          FROM payments p
          JOIN customers c ON c.id = p.customer_id
          WHERE c.user_id = ?
          AND p.payment_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
          GROUP BY DATE_FORMAT(p.payment_date, '%Y-%m'), DATE_FORMAT(p.payment_date, '%b')
          ORDER BY MIN(p.payment_date)
        `,
        [userId]
      );
    } catch (error) {
      if (error.code !== "ER_NO_SUCH_TABLE") {
        throw error;
      }

      [rows] = await db.query(
        `
          SELECT
            DATE_FORMAT(created_at, '%b') as month,
            SUM(advance_paid) as revenue
          FROM customers
          WHERE user_id = ?
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
          GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b')
          ORDER BY MIN(created_at)
        `,
        [userId]
      );
    }

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching revenue chart",
    });
  }
};
