const db = require("../config/db");
const axios = require("axios");
const { buildTemplatePayload } = require("../utils/templateBuilder");
const { processCampaign } = require("../services/campaignService");

exports.sendCampaign = async (req, res) => {
    try {
        const { name, phones, template_name, scheduled_at } = req.body;

        const [result] = await db.query(
            `INSERT INTO campaigns 
             (name, message_template, total_count, scheduled_at, status) 
             VALUES (?, ?, ?, ?, ?)`,
            [name, template_name, phones.length, scheduled_at || null, "pending"]
        );

        const campaignId = result.insertId;

        // insert logs
        for (let phone of phones) {
            await db.query(
                "INSERT INTO campaign_logs (campaign_id, phone, status) VALUES (?, ?, ?)",
                [campaignId, phone, "pending"]
            );
        }

        res.json({ success: true, campaignId });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Campaign failed" });
    }
};
