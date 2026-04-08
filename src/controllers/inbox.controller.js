const db = require("../config/db");

// 📌 get conversations
exports.getConversations = async (req, res) => {
  const [rows] = await db.query(`
    SELECT 
      conv.customer_id,
      conv.last_message,
      conv.updated_at,
      c.name,
      c.phone
    FROM conversations conv
    LEFT JOIN customers c ON c.id = conv.customer_id
    ORDER BY conv.updated_at DESC
  `);

  res.json(rows);
};

// 📌 get messages
exports.getMessages = async (req, res) => {
  const { customer_id } = req.params;

  const [rows] = await db.query(
    "SELECT * FROM messages WHERE customer_id=? ORDER BY id ASC",
    [customer_id]
  );

  res.json(rows);
};