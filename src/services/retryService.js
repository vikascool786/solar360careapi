const axios = require("axios");
const db = require("../config/db");
const { buildTemplatePayload } = require("../utils/templateBuilder");

exports.retryFailedMessages = async () => {
  console.log("🔁 Checking failed messages...");

  const [logs] = await db.query(`
   SELECT 
  cl.id AS campaign_log_id,
  cl.phone,
  cl.status,
  cl.retry_count,
  cl.response,
  c.message_template,
  t.*
FROM campaign_logs cl
JOIN campaigns c ON cl.campaign_id = c.id
JOIN templates t ON t.name = c.message_template
WHERE cl.status = 'failed'
AND cl.retry_count < 3
LIMIT 20
  `);

  for (let log of logs) {
    try {
      const payload = buildTemplatePayload(log, log.phone);

      const response = await axios.post(
        `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );

      console.log("WhatsApp API response:", JSON.stringify(response.data));

      const messageId = response?.data?.messages?.[0]?.id;

      if (!messageId) {
        console.log("❌ message_id missing!", response.data);
      }
      console.log(
        "Updating log ID:",
        log.campaign_log_id,
        "with messageId:",
        messageId,
      );

      await db.query(
        `UPDATE campaign_logs 
   SET status='sent', 
       response=?, 
       retry_count = retry_count + 1,
       last_attempt_at = NOW(),
       message_id = ?
   WHERE id=?`,
        [JSON.stringify(response.data), messageId, log.campaign_log_id],
      );

      console.log(`✅ Retried success: ${log.phone}`);
    } catch (err) {
      await db.query(
        `UPDATE campaign_logs 
         SET retry_count = retry_count + 1,
             last_attempt_at = NOW(),
             response=?
         WHERE id=?`,
        [JSON.stringify(err.response?.data), log.id],
      );

      console.log(`❌ Retry failed: ${log.phone}`);
    }

    // small delay
    await new Promise((r) => setTimeout(r, 1500));
  }
};
