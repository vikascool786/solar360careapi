const axios = require("axios");
const db = require("../config/db");

// 🔥 Sync templates from WhatsApp
exports.syncTemplates = async (req, res) => {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v22.0/${process.env.WABA_ID}/message_templates`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      }
    );

    const templates = response.data.data;

    for (let t of templates) {
      const header = t.components?.find((c) => c.type === "HEADER");

      const headerType = header?.format || null;

      const hasBodyParams = t.components?.some(
        (c) => c.type === "BODY" && c.text?.includes("{{")
      );

      // UPSERT
      await db.query(
        `INSERT INTO templates 
   (name, template_name, category, language, header_type, has_body_params, raw_json)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE 
     category=VALUES(category),
     language=VALUES(language),
     header_type=VALUES(header_type),
     has_body_params=VALUES(has_body_params),
     raw_json=VALUES(raw_json)`,
        [
          t.name,
          t.name,
          t.category,
          t.language,
          headerType,
          hasBodyParams,
          JSON.stringify(t),
        ]
      );
    }

    res.json({ success: true, count: templates.length });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Template sync failed" });
  }
};

// 📄 Get templates from DB
exports.getTemplates = async (req, res) => {
  const [rows] = await db.query("SELECT * FROM templates");
  res.json(rows);
};