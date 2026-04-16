const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");

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

    const [[totalIncome]] = await db.query(
      `SELECT SUM(advance_paid) as total FROM customers WHERE user_id = ?`,
      [userId]
    );

    const [[pendingPayments]] = await db.query(
      `SELECT SUM(balance) as total FROM customers WHERE user_id = ?`,
      [userId]
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

    const [[pendingInvoices]] = await db.query(
      `SELECT COUNT(*) as total
       FROM customers
       WHERE user_id = ?
       AND balance > 0`,
      [userId]
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
    const [rows] = await db.query(
      `
        SELECT
          DATE_FORMAT(created_at, '%b') as month,
          SUM(advance_paid) as revenue
        FROM customers
        WHERE user_id = ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY MIN(created_at)
      `,
      [userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error fetching revenue chart",
    });
  }
};
