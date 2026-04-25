const axios = require("axios");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7).trim();
}

async function getLoggedInWhatsappAccount(req) {
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
    req.query.whatsappAccountId || req.body?.whatsappAccountId;

  const params = [decoded.id];
  let query = `
    SELECT id, waba_id, access_token, name
    FROM whatsapp_accounts
    WHERE user_id = ?
  `;

  if (requestedWhatsappAccountId) {
    query += " AND id = ?";
    params.push(requestedWhatsappAccountId);
  }

  query += " ORDER BY id DESC LIMIT 1";

  const [accounts] = await db.query(query, params);

  if (!accounts.length) {
    const error = new Error("No Facebook WhatsApp tenant found for this user");
    error.statusCode = 404;
    throw error;
  }

  if (!accounts[0].access_token) {
    const error = new Error("Selected tenant does not have an access token");
    error.statusCode = 400;
    throw error;
  }

  return {
    userId: decoded.id,
    whatsappAccount: accounts[0],
  };
}

// Sync templates from WhatsApp
exports.syncTemplates = async (req, res) => {
  try {
    const { whatsappAccount } = await getLoggedInWhatsappAccount(req);

    const response = await axios.get(
      `https://graph.facebook.com/${process.env.FB_API_VERSION}/${whatsappAccount.waba_id}/message_templates`,
      {
        headers: {
          Authorization: `Bearer ${whatsappAccount.access_token}`,
        },
      }
    );

    const templates = response.data.data || [];

    for (const template of templates) {
      const header = template.components?.find((component) => component.type === "HEADER");

      const headerType = header?.format || null;

      const hasBodyParams = template.components?.some(
        (component) => component.type === "BODY" && component.text?.includes("{{")
      );

      // UPSERT
      await db.query(
        `INSERT INTO templates 
   (whatsapp_account_id, name, template_name, category, language, header_type, has_body_params, raw_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE 
     name=VALUES(name),
     category=VALUES(category),
     language=VALUES(language),
     header_type=VALUES(header_type),
     has_body_params=VALUES(has_body_params),
     raw_json=VALUES(raw_json)`,
        [
          whatsappAccount.id,
          template.name,
          template.name,
          template.category,
          template.language,
          headerType,
          hasBodyParams,
          JSON.stringify(template),
        ]
      );
    }

    res.json({
      success: true,
      count: templates.length,
      whatsappAccountId: whatsappAccount.id,
      wabaId: whatsappAccount.waba_id,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      error: err.message || "Template sync failed",
    });
  }
};

// Get templates from DB
exports.getTemplates = async (req, res) => {
  try {
    const { whatsappAccount } = await getLoggedInWhatsappAccount(req);
    const [rows] = await db.query(
      "SELECT * FROM templates WHERE whatsapp_account_id = ? ORDER BY id DESC",
      [whatsappAccount.id]
    );

    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to fetch templates",
    });
  }
};
