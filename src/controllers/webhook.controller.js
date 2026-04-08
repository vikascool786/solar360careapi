const db = require("../config/db");

// ✅ STEP 3A — VERIFY WEBHOOK
exports.verifyWebhook = (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("VERIFY HIT");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified");
        return res.status(200).send(challenge);
    } else {
        return res.sendStatus(403);
    }
};

// ✅ STEP 3B — RECEIVE MESSAGE
exports.receiveMessage = async (req, res) => {
    console.log("WEBHOOK HIT:", JSON.stringify(req.body));
    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;

        // 🔥 1. HANDLE STATUS UPDATES (UPGRADED)
        if (value?.statuses) {
            const statusObj = value.statuses[0];

            const status = statusObj.status; // sent, delivered, read, failed
            const messageId = statusObj.id;
            const phone = statusObj.recipient_id;

            console.log("📊 STATUS UPDATE:", status, messageId, phone, statusObj);

            let error = null;

            if (status === "failed") {
                error = JSON.stringify(statusObj.errors || null);
            }

            const [result] = await db.query(
                `UPDATE campaign_logs 
                 SET 
                   status = ?,
                   error = ?,
                   response = ?,
                   last_attempt_at = NOW()
                 WHERE message_id = ?`,
                [status, error, JSON.stringify(statusObj), messageId]
            );

            // 🔥 fallback if message_id not found
            if (result.affectedRows === 0) {
                console.log("⚠️ message_id not found, fallback to phone");

                await db.query(
                    `UPDATE campaign_logs 
                     SET 
                       status = ?,
                       error = ?,
                       response = ?,
                       last_attempt_at = NOW()
                     WHERE RIGHT(phone, 10) = ?
                     AND message_id IS NULL
                     ORDER BY id DESC
                     LIMIT 1`,
                    [status, error, JSON.stringify(statusObj), phone.slice(-10)]
                );
            }

            // 🔍 Debug if no row updated
            if (result.affectedRows === 0) {
                console.log("⚠️ No row found for message_id:", messageId);
            }

            return res.sendStatus(200);
        }

        // 🔥 2. HANDLE INCOMING USER MESSAGES (ENHANCED)

        const message = value?.messages?.[0];

        if (!message) {
            return res.sendStatus(200);
        }

        const phone = message.from;
        const text = message.text?.body;

        console.log("📩 MESSAGE RECEIVED:", phone, text);

        // 🔍 Normalize phone (IMPORTANT FIX)
        const phone10 = phone.slice(-10);

        const [customers] = await db.query(
            "SELECT * FROM customers WHERE RIGHT(phone, 10) = ?",
            [phone10]
        );

        let customer_id;

        if (customers.length > 0) {
            customer_id = customers[0].id;
        } else {
            // 🔥 CREATE NEW CUSTOMER (LEAD)
            const [result] = await db.query(
                `INSERT INTO customers 
            (name, phone, customer_type, plan_type, payment_status, created_at)
            VALUES (?, ?, ?, ?, ?, NOW())`,
                [phone, phone, "lead", "lead", "pending"]
            );

            customer_id = result.insertId;
        }

        // 💾 save message
        await db.query(`INSERT INTO messages (customer_id, phone, message, message_type, type, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())`, [customer_id, phone, text, "text", "inbound", "received"]);

        // 🔄 update conversation
        await db.query(
            `INSERT INTO conversations (customer_id, last_message, updated_at)
            VALUES (?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
            last_message = VALUES(last_message),
            updated_at = NOW()`,
            [customer_id, text]
        );

        // 🔥 3. MARK CAMPAIGN AS REPLIED (NEW FEATURE)
        await db.query(
            `UPDATE campaign_logs
             SET 
               replied = 1,
               replied_at = NOW(),
               status = IF(status != 'failed', 'replied', status)
             WHERE RIGHT(phone, 10) = ?
             ORDER BY id DESC
             LIMIT 1`,
            [phone10]
        );

        res.sendStatus(200);

    } catch (err) {
        console.error("WEBHOOK ERROR:", err);
        res.sendStatus(500);
    }
};