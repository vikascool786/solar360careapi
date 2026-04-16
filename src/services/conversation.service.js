const db = require("../config/db");

async function upsertConversationSummary({
    customerId,
    lastMessage,
    lastMessageType,
    direction,
    markAsRead = false,
}) {
    const isInbound = direction === "inbound";
    const isRead = markAsRead || !isInbound ? 1 : 0;
    const unreadIncrement = isInbound && !markAsRead ? 1 : 0;

    await db.query(
        `INSERT INTO conversations (
            customer_id,
            last_message,
            last_message_type,
            last_message_at,
            unread_count,
            is_read,
            last_inbound_at,
            last_outbound_at,
            updated_at
        )
        VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
            last_message = VALUES(last_message),
            last_message_type = VALUES(last_message_type),
            last_message_at = NOW(),
            unread_count = CASE
                WHEN ? = 'inbound' AND ? = 0 THEN COALESCE(unread_count, 0) + 1
                WHEN ? = 1 THEN 0
                ELSE COALESCE(unread_count, 0)
            END,
            is_read = CASE
                WHEN ? = 'inbound' AND ? = 0 THEN 0
                ELSE 1
            END,
            last_inbound_at = CASE
                WHEN ? = 'inbound' THEN NOW()
                ELSE last_inbound_at
            END,
            last_outbound_at = CASE
                WHEN ? = 'outbound' THEN NOW()
                ELSE last_outbound_at
            END,
            updated_at = NOW()`,
        [
            customerId,
            lastMessage,
            lastMessageType,
            unreadIncrement,
            isRead,
            isInbound ? new Date() : null,
            !isInbound ? new Date() : null,
            direction,
            markAsRead ? 1 : 0,
            markAsRead ? 1 : 0,
            direction,
            markAsRead ? 1 : 0,
            direction,
            direction,
        ]
    );
}

async function markConversationAsRead(customerId) {
    const [result] = await db.query(
        `UPDATE conversations
         SET is_read = 1,
             unread_count = 0,
             updated_at = NOW()
         WHERE customer_id = ?`,
        [customerId]
    );

    return result;
}

module.exports = {
    upsertConversationSummary,
    markConversationAsRead,
};
