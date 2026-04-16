const db = require("../config/db");
const { getIO } = require("../socket");

async function getConversationSummary(customerId) {
  const [rows] = await db.query(
    `SELECT
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
    LEFT JOIN customers c ON c.id = conv.customer_id
    WHERE conv.customer_id = ?
    LIMIT 1`,
    [customerId]
  );

  return rows[0] || null;
}

async function getMessageById(messageId) {
  const [[message]] = await db.query(
    "SELECT * FROM messages WHERE id = ? LIMIT 1",
    [messageId]
  );

  return message || null;
}

function emitSafely(eventName, payload, room) {
  try {
    const io = getIO();

    if (room) {
      io.to(room).emit(eventName, payload);
      return;
    }

    io.emit(eventName, payload);
  } catch (error) {
    console.error(`SOCKET EMIT ERROR (${eventName}):`, error.message);
  }
}

async function emitConversationUpdated(customerId) {
  const conversation = await getConversationSummary(customerId);

  if (!conversation) {
    return null;
  }

  const payload = {
    customerId: Number(customerId),
    conversation,
  };

  emitSafely("conversation:updated", payload, "inbox");
  emitSafely("conversation:updated", payload, `conversation:${customerId}`);

  return conversation;
}

async function emitMessageCreated(messageId) {
  const message = await getMessageById(messageId);

  if (!message) {
    return null;
  }

  const payload = {
    customerId: Number(message.customer_id),
    message,
  };

  emitSafely("message:new", payload, "inbox");
  emitSafely("message:new", payload, `conversation:${message.customer_id}`);

  return message;
}

function emitConversationRead(customerId) {
  const payload = {
    customerId: Number(customerId),
    is_read: 1,
    unread_count: 0,
  };

  emitSafely("conversation:read", payload, "inbox");
  emitSafely("conversation:read", payload, `conversation:${customerId}`);
}

function emitMessageStatusUpdate(payload) {
  const customerId = payload.customerId || null;

  emitSafely("message:status", payload, "inbox");

  if (customerId) {
    emitSafely("message:status", payload, `conversation:${customerId}`);
  }
}

module.exports = {
  emitConversationRead,
  emitConversationUpdated,
  emitMessageCreated,
  emitMessageStatusUpdate,
  getConversationSummary,
  getMessageById,
};
