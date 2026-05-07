const db = require("../config/db");
const { requireAuthenticatedUserId } = require("../utils/auth");
const { decorateInvoicesForCollection } = require("../services/billing.service");

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
    const [[paymentKpis]] = await db.query(
      `SELECT
         COALESCE(SUM(p.amount), 0) AS totalIncome,
         COALESCE(SUM(
           CASE
             WHEN p.payment_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
              AND p.payment_date < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
             THEN p.amount
             ELSE 0
           END
         ), 0) AS totalPaidThisMonth
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       WHERE c.user_id = ?`,
      [userId]
    );

    const [invoiceRows] = await db.query(
      `SELECT
          i.*,
          cp.plan_type,
          cp.frequency,
          cp.billing_cycle,
          cp.start_date
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN customer_plans cp ON cp.id = i.customer_plan_id
       WHERE c.user_id = ?`,
      [userId]
    );

    const decoratedInvoices = await decorateInvoicesForCollection(
      db,
      invoiceRows
    );
    const collectibleInvoices = decoratedInvoices.filter(
      (invoice) => Number(invoice.is_collectible || 0) === 1
    );
    const pendingInvoices = collectibleInvoices.filter(
      (invoice) => Number(invoice.balance || 0) > 0
    );
    const pendingCustomerIds = new Set(
      pendingInvoices.map((invoice) => invoice.customer_id)
    );

    const pendingCustomers = pendingCustomerIds.size;

    return {
      totalIncome: paymentKpis.totalIncome || 0,
      totalPaidThisMonth: paymentKpis.totalPaidThisMonth || 0,
      totalInvoiceAmount: collectibleInvoices.reduce(
        (sum, invoice) => sum + Number(invoice.amount || 0),
        0
      ),
      totalPendingAmount: pendingInvoices.reduce(
        (sum, invoice) => sum + Number(invoice.balance || 0),
        0
      ),
      overdueAmount: pendingInvoices.reduce(
        (sum, invoice) =>
          invoice.status === "overdue"
            ? sum + Number(invoice.balance || 0)
            : sum,
        0
      ),
      pendingPaymentInvoices: pendingInvoices.length,
      overdueInvoices: pendingInvoices.filter(
        (invoice) => invoice.status === "overdue"
      ).length,
      partialInvoices: collectibleInvoices.filter(
        (invoice) => invoice.status === "partial"
      ).length,
      paidInvoices: collectibleInvoices.filter(
        (invoice) => invoice.status === "paid"
      ).length,
      totalInvoices: decoratedInvoices.length,
      pendingCustomers,
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
