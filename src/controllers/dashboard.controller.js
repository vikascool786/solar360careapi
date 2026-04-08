const db = require('../config/db');

exports.getDashboardStats = async (req, res) => {
    try {
        const [[totalCustomers]] = await db.query(
            `SELECT COUNT(*) as total FROM customers`
        );

        const [[todayServices]] = await db.query(
            `SELECT COUNT(*) as total 
             FROM service_visits
             WHERE status = 'pending'
             AND DATE(next_service_date) = CURDATE()`
        );

        const [[overdueServices]] = await db.query(
            `SELECT COUNT(*) as total 
             FROM service_visits
             WHERE status = 'pending'
             AND DATE(next_service_date) < CURDATE()`
        );

        const [[totalIncome]] = await db.query(
            `SELECT SUM(advance_paid) as total FROM customers`
        );

        const [[pendingPayments]] = await db.query(
            `SELECT SUM(balance) as total FROM customers`
        );

        // ✅ NEW KPI QUERIES

        const [[activeAMCContracts]] = await db.query(
            `SELECT COUNT(*) as total 
            FROM customers 
            WHERE plan_type NOT IN ('One Time', 'Monthly')`
        );
        const [[activeMonthlyContracts]] = await db.query(
            `SELECT COUNT(*) as total 
            FROM customers 
            WHERE plan_type = 'Monthly'`
        );

        const [[pendingInvoices]] = await db.query(
            `SELECT COUNT(*) as total 
             FROM customers 
             WHERE balance > 0`
        );

        // 📊 CAMPAIGN STATS
        const [[totalCampaigns]] = await db.query(`
            SELECT COUNT(*) as total FROM campaigns
        `);

        const [[totalSent]] = await db.query(`
            SELECT COUNT(*) as total 
            FROM campaign_logs 
            WHERE status IN ('sent','delivered','read','replied')
        `);

        const [[delivered]] = await db.query(`
            SELECT COUNT(*) as total 
            FROM campaign_logs 
            WHERE status = 'delivered'
        `);

        const [[read]] = await db.query(`
            SELECT COUNT(*) as total 
            FROM campaign_logs 
            WHERE status = 'read'
        `);

        const [[failed]] = await db.query(`
            SELECT COUNT(*) as total 
            FROM campaign_logs 
            WHERE status = 'failed'
        `);

        const [[replied]] = await db.query(`
            SELECT COUNT(*) as total 
            FROM campaign_logs 
            WHERE replied = 1
        `);

        // optional (if messages table exists)
        let failedMessages = { total: 0 };

        try {
            const [[failed]] = await db.query(
                `SELECT COUNT(*) as total 
                 FROM messages 
                 WHERE status = 'failed'`
            );
            failedMessages = failed;
        } catch (e) {
            // ignore if table not ready
        }

        res.json({
            totalCustomers: totalCustomers.total,
            todayServices: todayServices.total,
            overdueServices: overdueServices.total,
            totalIncome: totalIncome.total || 0,
            pendingPayments: pendingPayments.total || 0,

            // ✅ NEW
            activeAMCContracts: activeAMCContracts.total,
            activeMonthlyContracts: activeMonthlyContracts.total,
            pendingInvoices: pendingInvoices.total,
            failedMessages: failedMessages.total,

            // ✅ campaigns
            campaigns: {
                total: totalCampaigns.total,
                sent: totalSent.total,
                delivered: delivered.total,
                read: read.total,
                failed: failed.total,
                replied: replied.total,
            },
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error fetching dashboard" });
    }
};

exports.getUpcomingServices = async (req, res) => {
    try {
        const [rows] = await db.query(`
      SELECT 
        sv.id,
        sv.next_service_date,
        c.name,
        c.phone
      FROM service_visits sv
      JOIN customers c ON c.id = sv.customer_id
      WHERE sv.status = 'pending'
      ORDER BY sv.next_service_date ASC
      LIMIT 5
    `);

        res.json(rows);

    } catch (err) {
        res.status(500).json({ message: "Error fetching upcoming services" });
    }
};

exports.getRevenueChart = async (req, res) => {
    try {
        const [rows] = await db.query(`
      SELECT 
        DATE_FORMAT(created_at, '%b') as month,
        SUM(advance_paid) as revenue
      FROM customers
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY MIN(created_at)
    `);

        res.json(rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error fetching revenue chart" });
    }
};