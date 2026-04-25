const db = require("../config/db");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7).trim();
}

async function getLoggedInSenderContext(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error("Authorization token is required");
    error.statusCode = 401;
    throw error;
  }

  let decoded;

  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    error.statusCode = 401;
    error.message = "Invalid authorization token";
    throw error;
  }

  const requestedWhatsappAccountId =
    req.body.whatsappAccountId || req.query.whatsappAccountId;
  const requestedPhoneRecordId = req.body.phoneNumberId || req.query.phoneNumberId;

  const params = [decoded.id];
  let query = `
    SELECT
      wa.id AS whatsapp_account_id,
      wa.waba_id,
      wa.access_token,
      pn.id AS phone_record_id,
      pn.phone_number_id AS whatsapp_phone_number_id,
      pn.display_number
    FROM whatsapp_accounts wa
    JOIN phone_numbers pn ON pn.whatsapp_account_id = wa.id
    WHERE wa.user_id = ?
  `;

  if (requestedWhatsappAccountId) {
    query += " AND wa.id = ?";
    params.push(requestedWhatsappAccountId);
  }

  if (requestedPhoneRecordId) {
    query += " AND pn.id = ?";
    params.push(requestedPhoneRecordId);
  }

  query += " ORDER BY pn.id DESC LIMIT 1";

  const [rows] = await db.query(query, params);

  if (!rows.length) {
    const error = new Error("No WhatsApp sender found for this user");
    error.statusCode = 404;
    throw error;
  }

  return rows[0];
}

// it only creates campaign and logs, actual sending is handled by cron job in campaignService.js
exports.sendCampaign = async (req, res) => {
  try {
    const { name, phones, template_name, scheduled_at } = req.body;
    const senderContext = await getLoggedInSenderContext(req);

    if (!Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ error: "phones must be a non-empty array" });
    }

    const [[template]] = await db.query(
      `SELECT id FROM templates WHERE whatsapp_account_id = ? AND name = ? LIMIT 1`,
      [senderContext.whatsapp_account_id, template_name]
    );

    if (!template) {
      return res.status(404).json({
        error: "Template not found for the selected WhatsApp tenant",
      });
    }

    const [result] = await db.query(
      `INSERT INTO campaigns
       (name, message_template, total_count, scheduled_at, status, whatsapp_account_id, phone_number_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        template_name,
        phones.length,
        scheduled_at || null,
        "pending",
        senderContext.whatsapp_account_id,
        senderContext.phone_record_id,
      ]
    );

    const campaignId = result.insertId;

    for (const phone of phones) {
      await db.query(
        "INSERT INTO campaign_logs (campaign_id, phone, status) VALUES (?, ?, ?)",
        [campaignId, phone, "pending"]
      );
    }

    res.json({
      success: true,
      campaignId,
      whatsappAccountId: senderContext.whatsapp_account_id,
      phoneNumberId: senderContext.phone_record_id,
      senderPhoneNumberId: senderContext.whatsapp_phone_number_id,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Campaign failed",
    });
  }
};
