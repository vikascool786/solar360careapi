const axios = require("axios");
const db = require("../config/db");
const { buildTemplatePayload } = require("../utils/templateBuilder");

exports.processCampaign = async (campaignId) => {
    console.log("🚀 Processing campaign:", campaignId);

    // get campaign + sender info
    const [[campaign]] = await db.query(
        `SELECT
            c.*,
            wa.access_token,
            pn.phone_number_id AS whatsapp_phone_number_id
        FROM campaigns c
        JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
        JOIN phone_numbers pn ON pn.id = c.phone_number_id
        WHERE c.id=?`,
        [campaignId]
    );

    if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found`);
    }

    const [[template]] = await db.query(
        "SELECT * FROM templates WHERE whatsapp_account_id=? AND name=?",
        [campaign.whatsapp_account_id, campaign.message_template]
    );

    if (!template) {
        throw new Error(
            `Template ${campaign.message_template} not found for tenant ${campaign.whatsapp_account_id}`
        );
    }

    const [logs] = await db.query(
        "SELECT * FROM campaign_logs WHERE campaign_id=? AND status='pending'",
        [campaignId]
    );

    let count = 0;

    for (let log of logs) {
        try {
            const payload = buildTemplatePayload(template, log.phone);

            const response = await axios.post(
                `https://graph.facebook.com/${process.env.FB_API_VERSION}/${campaign.whatsapp_phone_number_id}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${campaign.access_token}`,
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
