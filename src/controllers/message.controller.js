const axios = require("axios");
const db = require("../config/db");

exports.sendMessage = async (req, res) => {
    try {
        const { customer_id, phone, name } = req.body;

        const response = await axios.post(
            `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
                "messaging_product": "whatsapp",
                "to": phone,
                "type": "template",
                "template": {
                    "name": "solar_cleaning_monthly_in_nagpur",
                    "language": {
                        "code": "en"
                    },
                    "components": [
                        {
                            "type": "header",
                            "parameters": [
                                {
                                    "type": "image",
                                    "image": {
                                        "link": "https://solar360care.com/wp-content/uploads/2026/03/solar-panel-cleaning-nagpur-2.jpeg"
                                    }
                                }
                            ]
                        },
                        // {
                        //     type: "body",
                        //     parameters: [
                        //         {
                        //             type: "text",
                        //             text: name,
                        //         },
                        //         {
                        //             type: "text",
                        //             text: "Tomorrow",
                        //         },
                        //     ],
                        // },
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        // ✅ Store in DB
       await db.query(
            `INSERT INTO messages 
            (customer_id, phone, message, message_type, type, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [customer_id, phone, "solar_cleaning_monthly_in_nagpur", "template", "outbound", "sent"]
        );

        res.json({ success: true, response: response.data });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: "Message failed" });
    }
};

exports.sendTextMessage = async (req, res) => {
    try {
        const { customer_id, phone, message } = req.body;

        const response = await axios.post(
            `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: phone,
                type: "text",
                text: {
                    body: message,
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        // 💾 store message
        await db.query(
            `INSERT INTO messages 
            (customer_id, phone, message, message_type, type, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [customer_id, phone, message, "text", "outbound", "sent"]
        );

        // 🔄 update conversation
        await db.query(
            `UPDATE conversations 
       SET last_message=?, updated_at=NOW()
       WHERE customer_id=?`,
            [message, customer_id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "Send failed" });
    }
};