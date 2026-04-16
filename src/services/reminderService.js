const cron = require("node-cron");
const db = require("../config/db");
const axios = require("axios");
const { retryFailedMessages } = require("./retryService");
const { processCampaign } = require("./campaignService");

cron.schedule("* * * * *", async () => {
  console.log("📅 Checking scheduled campaigns...");

  const [campaigns] = await db.query(`
    SELECT * FROM campaigns
    WHERE status = 'pending'
    AND (scheduled_at IS NULL OR scheduled_at <= NOW())
  `);

  for (let campaign of campaigns) {
    console.log("🚀 Starting campaign:", campaign.id);

    await db.query(
      "UPDATE campaigns SET status='sending' WHERE id=?",
      [campaign.id]
    );

    processCampaign(campaign.id);
  }
});

// every 5 minutes
cron.schedule("*/1 * * * *", async () => {
  console.log("⏰ Running retry job...");
  await retryFailedMessages();
});

cron.schedule("57 23 * * *", async () => {
  console.log("Running auto reminders at 11:48 PM...");

  try {
    const [rows] = await db.query(`
      SELECT sv.*, c.phone, c.name 
      FROM service_visits sv
      JOIN customers c ON c.id = sv.customer_id
      WHERE DATE(sv.next_service_date) = CURDATE()
      AND sv.reminder_sent = 0
    `);

    for (const r of rows) {
      try {
        await axios.post(
          `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: r.phone,
            type: "template",
            template: {
              name: "next_service_reminder", // You should create this template in your WABA with parameters for name and date
              language: { code: "en" },
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );

        // mark as sent
        await db.query(
          "UPDATE service_visits SET reminder_sent = 1 WHERE id = ?",
          [r.id]
        );

        console.log("Reminder sent to", r.phone);
      } catch (err) {
        console.error("Error sending reminder:", err.response?.data);
      }
    }
  } catch (err) {
    console.error(err);
  }
});
