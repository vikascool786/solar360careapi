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

async function getBillingKpis(userId, totalCustomerCount) {
  try {
    const [[billingKpis]] = await db.query(
      `SELECT
         COALESCE(p.total_income, 0) AS totalIncome,
         COALESCE(p.total_paid_this_month, 0) AS totalPaidThisMonth,
         COALESCE(i.total_invoice_amount, 0) AS totalInvoiceAmount,
         COALESCE(i.total_pending_amount, 0) AS totalPendingAmount,
         COALESCE(i.overdue_amount, 0) AS overdueAmount,
         COALESCE(i.pending_payment_invoices, 0) AS pendingPaymentInvoices,
         COALESCE(i.overdue_invoices, 0) AS overdueInvoices,
         COALESCE(i.partial_invoices, 0) AS partialInvoices,
         COALESCE(i.paid_invoices, 0) AS paidInvoices,
         COALESCE(i.total_invoices, 0) AS totalInvoices,
         COALESCE(i.pending_customers, 0) AS pendingCustomers
       FROM
         (
           SELECT
             COALESCE(SUM(p.amount), 0) AS total_income,
             COALESCE(SUM(
               CASE
                 WHEN p.payment_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                  AND p.payment_date < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
                 THEN p.amount
                 ELSE 0
               END
             ), 0) AS total_paid_this_month
           FROM payments p
           JOIN customers c ON c.id = p.customer_id
           WHERE c.user_id = ?
         ) p
       CROSS JOIN
         (
           SELECT
             COALESCE(SUM(i.amount), 0) AS total_invoice_amount,
             COALESCE(SUM(CASE WHEN i.balance > 0 THEN i.balance ELSE 0 END), 0) AS total_pending_amount,
             COALESCE(SUM(CASE WHEN i.status = 'overdue' AND i.balance > 0 THEN i.balance ELSE 0 END), 0) AS overdue_amount,
             SUM(CASE WHEN i.balance > 0 THEN 1 ELSE 0 END) AS pending_payment_invoices,
             SUM(CASE WHEN i.status = 'overdue' AND i.balance > 0 THEN 1 ELSE 0 END) AS overdue_invoices,
             SUM(CASE WHEN i.status = 'partial' THEN 1 ELSE 0 END) AS partial_invoices,
             SUM(CASE WHEN i.status = 'paid' THEN 1 ELSE 0 END) AS paid_invoices,
             COUNT(i.id) AS total_invoices,
             COUNT(DISTINCT CASE WHEN i.balance > 0 THEN i.customer_id END) AS pending_customers
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
           WHERE c.user_id = ?
         ) i`,
      [userId, userId]
    );

    const pendingCustomers = Number(billingKpis.pendingCustomers || 0);

    return {
      ...billingKpis,
      paidCustomers: Math.max(Number(totalCustomerCount || 0) - pendingCustomers, 0),
    };
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE") {
      throw error;
    }

    const [[fallbackKpis]] = await db.query(
      `SELECT
         COALESCE(SUM(advance_paid), 0) AS totalIncome,
         COALESCE(SUM(
           CASE
             WHEN created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
              AND created_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
             THEN advance_paid
             ELSE 0
           END
         ), 0) AS totalPaidThisMonth,
         COALESCE(SUM(plan_price), 0) AS totalInvoiceAmount,
         COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS totalPendingAmount,
         0 AS overdueAmount,
         SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END) AS pendingPaymentInvoices,
         0 AS overdueInvoices,
         0 AS partialInvoices,
         SUM(CASE WHEN balance <= 0 THEN 1 ELSE 0 END) AS paidInvoices,
         COUNT(*) AS totalInvoices,
         SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END) AS pendingCustomers
       FROM customers
       WHERE user_id = ?`,
      [userId]
    );

    const pendingCustomers = Number(fallbackKpis.pendingCustomers || 0);

    return {
      ...fallbackKpis,
      paidCustomers: Math.max(Number(totalCustomerCount || 0) - pendingCustomers, 0),
    };
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

    await markOverdueInvoices(userId).catch((error) => {
      if (error.code !== "ER_NO_SUCH_TABLE") {
        throw error;
      }
    });

    const billingKpis = await getBillingKpis(userId, totalCustomers.total);

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
      totalIncome: billingKpis.totalIncome || 0,
      pendingPayments: billingKpis.totalPendingAmount || 0,
      totalPendingAmount: billingKpis.totalPendingAmount || 0,
      totalPaidThisMonth: billingKpis.totalPaidThisMonth || 0,
      overdueAmount: billingKpis.overdueAmount || 0,
      activeAMCContracts: activeAMCContracts.total,
      activeMonthlyContracts: activeMonthlyContracts.total,
      pendingInvoices: billingKpis.pendingPaymentInvoices || 0,
      paidCustomers: billingKpis.paidCustomers || 0,
      pendingCustomers: billingKpis.pendingCustomers || 0,
      failedMessages: failedMessages.total,
      billing: {
        totalIncome: billingKpis.totalIncome || 0,
        totalPaidThisMonth: billingKpis.totalPaidThisMonth || 0,
        totalInvoiceAmount: billingKpis.totalInvoiceAmount || 0,
        totalPendingAmount: billingKpis.totalPendingAmount || 0,
        overdueAmount: billingKpis.overdueAmount || 0,
        pendingPaymentInvoices: billingKpis.pendingPaymentInvoices || 0,
        overdueInvoices: billingKpis.overdueInvoices || 0,
        partialInvoices: billingKpis.partialInvoices || 0,
        paidInvoices: billingKpis.paidInvoices || 0,
        totalInvoices: billingKpis.totalInvoices || 0,
        paidCustomers: billingKpis.paidCustomers || 0,
        pendingCustomers: billingKpis.pendingCustomers || 0,
      },
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
