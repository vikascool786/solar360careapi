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
  c.whatsapp_account_id,
  wa.access_token,
  pn.phone_number_id AS whatsapp_phone_number_id,
  t.*
FROM campaign_logs cl
JOIN campaigns c ON cl.campaign_id = c.id
JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
JOIN phone_numbers pn ON pn.id = c.phone_number_id
JOIN templates t ON t.whatsapp_account_id = c.whatsapp_account_id AND t.name = c.message_template
WHERE cl.status = 'failed'
AND cl.retry_count < 3
LIMIT 20
  `);

  for (let log of logs) {
    try {
      console.log("log.whatsapp_phone_number_id", log.whatsapp_phone_number_id);
      const payload = buildTemplatePayload(log, log.phone);

      const response = await axios.post(
        `https://graph.facebook.com/${process.env.FB_API_VERSION}/${log.whatsapp_phone_number_id}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${log.access_token}`,
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
        [JSON.stringify(err.response?.data), log.campaign_log_id],
      );

      console.log(`❌ Retry failed: ${log.phone}`);
    }

    // small delay
    await new Promise((r) => setTimeout(r, 1500));
  }
};
