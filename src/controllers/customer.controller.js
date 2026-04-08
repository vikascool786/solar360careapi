const db = require('../config/db');

exports.getAll = async (req, res) => {
    try {
        // 1. Query params
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || "";
        const area = req.query.area || "";
        const plan = req.query.plan || "";
        const type = req.query.type || "";

        const safeLimit = Math.min(limit, 100);
        const offset = (page - 1) * safeLimit;

        // 2. Build WHERE clause dynamically
        let where = "WHERE 1=1";
        let params = [];

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

        // 3. Get total count (with filters)
        const [countRows] = await db.query(
            `SELECT COUNT(*) as total FROM customers ${where}`,
            params
        );
        const total = countRows[0].total;

        // 4. Get paginated data
        const [rows] = await db.query(
            `SELECT * FROM customers
       ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
            [...params, safeLimit, offset]
        );

        // 5. Response
        res.json({
            data: rows,
            total,
            page,
            limit: safeLimit,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

function calculateNextDate(start_date, frequency) {
    const date = new Date(start_date);

    switch (frequency) {
        case "One Time":
            // once per month
            date.setMonth(date.getMonth() + 1);
            break;
        case "1/Month":
            // once per month
            date.setMonth(date.getMonth() + 1);
            break;

        case "Monthly":
        case "24/Year":
            // every 15 days
            date.setDate(date.getDate() + 15);
            break;

        case "14/Year":
            // ~365 / 14 ≈ 26 days
            date.setDate(date.getDate() + 26);
            break;

        default:
            throw new Error("Invalid frequency");
    }

    return date;
}

exports.create = async (req, res) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

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
        } = req.body;

        // ✅ Always calculate in backend
        const balance = Number(plan_price) - Number(advance_paid || 0);

        // ✅ Calculate next service date
        const next_service_date = calculateNextDate(start_date, frequency);

        // 1️⃣ Insert customer
        const [result] = await connection.query(
            `INSERT INTO customers 
      (name, phone, address, area, plan_type, plan_price, advance_paid, balance, start_date, next_service_date, frequency, customer_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            ]
        );

        const customerId = result.insertId;

        // 2️⃣ Create first service visit
        await connection.query(
            `INSERT INTO service_visits 
      (customer_id, visit_date, status, next_service_date, reminder_sent)
      VALUES (?, ?, 'pending', ?, 0)`,
            [customerId, start_date, next_service_date]
        );

        await connection.commit();

        res.json({ success: true, customerId });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Server error" + error });
    } finally {
        connection.release();
    }
};

exports.update = async (req, res) => {
    try {
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

        // ✅ Balance
        const balance = Number(plan_price) - Number(advance_paid || 0);

        // ✅ Next service date
        const next_service_date = calculateNextDate(start_date, frequency);

        // 1️⃣ Update customer
        const [customerResult] = await db.query(
            `UPDATE customers SET
        name=?,
        phone=?,
        address=?,
        area=?,
        plan_type=?,
        plan_price=?,
        advance_paid=?,
        balance=?,
        start_date=?,
        next_service_date=?,
        frequency=?,
        customer_type=?,
        notes=?
      WHERE id=?`,
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
            ]
        );

        if (customerResult.affectedRows === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }

        // 2️⃣ Update latest pending visit
        await db.query(
            `UPDATE service_visits 
       SET 
         visit_date=?,
         next_service_date=?
       WHERE customer_id=? 
       AND status='pending'
       ORDER BY id DESC
       LIMIT 1`,
            [start_date, next_service_date, id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error("UPDATE ERROR:", error);
        res.status(500).json({ message: "Server error" });
    }
};
exports.remove = async (req, res) => {
    const { id } = req.params;

    await db.query("DELETE FROM customers WHERE id=?", [id]);

    res.json({ success: true });
};