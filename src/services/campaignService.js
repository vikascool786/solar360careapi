const axios = require("axios");
const db = require("../config/db");
const { buildTemplatePayload } = require("../utils/templateBuilder");

exports.processCampaign = async (campaignId) => {
    console.log("🚀 Processing campaign:", campaignId);

    // 🔥 get campaign + template
    const [[campaign]] = await db.query(
        "SELECT * FROM campaigns WHERE id=?",
        [campaignId]
    );

    const [[template]] = await db.query(
        "SELECT * FROM templates WHERE name=?",
        [campaign.message_template]
    );

    const [logs] = await db.query(
        "SELECT * FROM campaign_logs WHERE campaign_id=? AND status='pending'",
        [campaignId]
    );

    let count = 0;

    for (let log of logs) {
        try {
            const payload = buildTemplatePayload(template, log.phone);

            const response = await axios.post(
                `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            const messageId = response.data.messages?.[0]?.id;

            await db.query(
                `UPDATE campaign_logs 
                 SET status='sent', 
                     sent_at=NOW(), 
                     response=?, 
                     last_attempt_at = NOW(),
                     message_id = ?
                 WHERE id=?`,
                [JSON.stringify(response.data), messageId, log.id]
            );

            // update count
            await db.query(
                `UPDATE campaigns 
                 SET sent_count = sent_count + 1 
                 WHERE id=?`,
                [campaignId]
            );

            count++;

            // 🔥 batch pause every 50
            if (count % 50 === 0) {
                console.log("⏸ Batch pause...");
                await new Promise(r => setTimeout(r, 10000));
            }

            // delay
            const delay = 1200 + Math.random() * 800;
            await new Promise(r => setTimeout(r, delay));

        } catch (err) {
            await db.query(
                `UPDATE campaign_logs 
                 SET status='failed', 
                     response=?, 
                     retry_count = retry_count + 1,
                     last_attempt_at = NOW()
                 WHERE id=?`,
                [JSON.stringify(err.response?.data), log.id]
            );
        }
    }

    await db.query(
        "UPDATE campaigns SET status='completed' WHERE id=?",
        [campaignId]
    );

    console.log("✅ Campaign completed:", campaignId);
};