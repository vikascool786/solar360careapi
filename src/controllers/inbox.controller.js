const db = require("../config/db");
const { markConversationAsRead } = require("../services/conversation.service");
const {
  emitConversationRead,
  getConversationSummary,
} = require("../services/inboxRealtime.service");
const { requireAuthenticatedUserId } = require("../utils/auth");

exports.getConversations = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const [rows] = await db.query(
      `
        SELECT
          conv.customer_id,
          conv.last_message,
          conv.last_message_type,
          conv.last_message_at,
          conv.last_inbound_at,
          conv.last_outbound_at,
          conv.unread_count,
          conv.is_read,
          conv.updated_at,
          c.name,
          c.phone,
          c.customer_type,
          c.plan_type,
          c.payment_status,
          CASE
            WHEN COALESCE(c.customer_type, 'lead') = 'lead' THEN 1
            ELSE 0
          END AS is_lead,
          CASE
            WHEN COALESCE(c.customer_type, 'lead') = 'lead'
             AND COALESCE(conv.unread_count, 0) > 0
             AND (
               conv.last_outbound_at IS NULL
               OR conv.last_inbound_at >= conv.last_outbound_at
             )
            THEN 1
            ELSE 0
          END AS is_fresh_lead,
          CASE
            WHEN COALESCE(c.customer_type, 'lead') = 'lead'
              THEN COALESCE(NULLIF(c.plan_type, ''), 'Lead')
            ELSE COALESCE(NULLIF(c.plan_type, ''), 'No Plan')
          END AS badge_label
        FROM conversations conv
        JOIN customers c ON c.id = conv.customer_id
        WHERE c.user_id = ?
        ORDER BY COALESCE(conv.unread_count, 0) DESC, conv.updated_at DESC
      `,
      [userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to fetch conversations",
    });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { customer_id } = req.params;

    const [rows] = await db.query(
      `SELECT m.*
       FROM messages m
       JOIN customers c ON c.id = m.customer_id
       WHERE m.customer_id = ? AND c.user_id = ?
       ORDER BY m.id ASC`,
      [customer_id, userId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to fetch messages",
    });
  }
};

exports.markConversationRead = async (req, res) => {
  try {
    const userId = requireAuthenticatedUserId(req);
    const { customer_id } = req.params;

    const [existing] = await db.query(
      `SELECT conv.customer_id
       FROM conversations conv
       JOIN customers c ON c.id = conv.customer_id
       WHERE conv.customer_id = ? AND c.user_id = ?
       LIMIT 1`,
      [customer_id, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    await markConversationAsRead(customer_id);
    const conversation = await getConversationSummary(customer_id);
    emitConversationRead(customer_id);

    res.json({
      success: true,
      customer_id: Number(customer_id),
      is_read: 1,
      unread_count: 0,
      conversation,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to update conversation",
    });
  }
};
