const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const db = require("../config/db");
const { upsertConversationSummary } = require("../services/conversation.service");
const {
    emitConversationUpdated,
    emitMessageCreated,
} = require("../services/inboxRealtime.service");

function getAbsoluteMediaUrl(req, mediaUrl = "") {
    if (!mediaUrl) {
        return null;
    }

    if (/^https?:\/\//i.test(mediaUrl)) {
        return mediaUrl;
    }

    if (mediaUrl.startsWith("/")) {
        return `${req.protocol}://${req.get("host")}${mediaUrl}`;
    }

    return `${req.protocol}://${req.get("host")}/${mediaUrl.replace(/^\/+/, "")}`;
}

function normalizeOutgoingType(type, mimeType = "") {
    const normalized = String(type || "").trim().toLowerCase();

    if (["text", "image", "video", "audio", "document", "template"].includes(normalized)) {
        return normalized;
    }

    if (["pdf", "file", "attachment"].includes(normalized)) {
        return "document";
    }

    if (normalized === "media") {
        if (mimeType.startsWith("image/")) {
            return "image";
        }

        if (mimeType.startsWith("video/")) {
            return "video";
        }

        if (mimeType.startsWith("audio/")) {
            return "audio";
        }

        return "document";
    }

    return "text";
}

function buildMessagePreview({ messageType, text, caption, fileName }) {
    if (messageType === "text") {
        return text || "";
    }

    if (messageType === "image") {
        return caption || "[Image]";
    }

    if (messageType === "video") {
        return caption || "[Video]";
    }

    if (messageType === "audio") {
        return "[Audio]";
    }

    if (messageType === "document") {
        return caption || fileName || "[Document]";
    }

    if (messageType === "template") {
        return text || "[Template]";
    }

    return text || caption || "[Attachment]";
}

function buildWhatsAppMessagePayload(req, body) {
    const {
        phone,
        message,
        text,
        media_url,
        mediaUrl,
        file_name,
        fileName,
        mime_type,
        mimeType,
        caption,
        type,
        message_type,
    } = body;

    const resolvedMimeType = mime_type || mimeType || "";
    const messageType = normalizeOutgoingType(type || message_type, resolvedMimeType);
    const resolvedText = text || message || "";
    const resolvedMediaUrl = getAbsoluteMediaUrl(req, media_url || mediaUrl || "");
    const resolvedFileName = file_name || fileName || null;

    if (!phone) {
        const error = new Error("phone is required");
        error.statusCode = 400;
        throw error;
    }

    if (messageType === "text") {
        if (!resolvedText.trim()) {
            const error = new Error("message is required for text messages");
            error.statusCode = 400;
            throw error;
        }

        return {
            messageType,
            payload: {
                messaging_product: "whatsapp",
                to: phone,
                type: "text",
                text: {
                    body: resolvedText,
                },
            },
            preview: buildMessagePreview({
                messageType,
                text: resolvedText,
            }),
            mediaUrl: null,
            mimeType: null,
            fileName: null,
        };
    }

    if (messageType === "template") {
        const error = new Error("template sending is not supported by this generic endpoint");
        error.statusCode = 400;
        throw error;
    }

    if (!resolvedMediaUrl) {
        const error = new Error("media_url is required for non-text messages");
        error.statusCode = 400;
        throw error;
    }

    const payload = {
        messaging_product: "whatsapp",
        to: phone,
        type: messageType,
        [messageType]: {
            link: resolvedMediaUrl,
        },
    };

    if (caption && ["image", "video", "document"].includes(messageType)) {
        payload[messageType].caption = caption;
    }

    if (resolvedFileName && messageType === "document") {
        payload[messageType].filename = resolvedFileName;
    }

    return {
        messageType,
        payload,
        preview: buildMessagePreview({
            messageType,
            text: resolvedText,
            caption,
            fileName: resolvedFileName,
        }),
        mediaUrl: media_url || mediaUrl || null,
        mimeType: resolvedMimeType || null,
        fileName: resolvedFileName,
    };
}

async function persistOutboundMessage({
    customerId,
    phone,
    preview,
    messageType,
    mediaUrl,
    mimeType,
    fileName,
    waMessageId,
}) {
    const [insertResult] = await db.query(
        `INSERT INTO messages 
        (
            customer_id,
            phone,
            message,
            message_type,
            type,
            status,
            message_id,
            wa_message_id,
            media_url,
            mime_type,
            file_name,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
            customerId,
            phone,
            preview,
            messageType,
            "outbound",
            "sent",
            waMessageId || null,
            waMessageId || null,
            mediaUrl || null,
            mimeType || null,
            fileName || null,
        ]
    );

    await upsertConversationSummary({
        customerId,
        lastMessage: preview,
        lastMessageType: messageType,
        direction: "outbound",
        markAsRead: true,
    });

    await emitMessageCreated(insertResult.insertId);
    await emitConversationUpdated(customerId);

    return insertResult.insertId;
}

exports.sendMessage = async (req, res) => {
    try {
        const { customer_id, phone, name } = req.body;

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
                "messaging_product": "whatsapp",
                "to": phone,
                "type": "template",
                "template": {
                    "name": "solar_cleaning_monthly_in_nagpur",
                    "language": {
                        "code": "en"
                    },
                    "components": [
                        {
                            "type": "header",
                            "parameters": [
                                {
                                    "type": "image",
                                    "image": {
                                        "link": "https://solar360care.com/wp-content/uploads/2026/03/solar-panel-cleaning-nagpur-2.jpeg"
                                    }
                                }
                            ]
                        },
                        // {
                        //     type: "body",
                        //     parameters: [
                        //         {
                        //             type: "text",
                        //             text: name,
                        //         },
                        //         {
                        //             type: "text",
                        //             text: "Tomorrow",
                        //         },
                        //     ],
                        // },
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        // ✅ Store in DB
       const [insertResult] = await db.query(
            `INSERT INTO messages 
            (customer_id, phone, message, message_type, type, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [customer_id, phone, "solar_cleaning_monthly_in_nagpur", "template", "outbound", "sent"]
        );

        await upsertConversationSummary({
            customerId: customer_id,
            lastMessage: "solar_cleaning_monthly_in_nagpur",
            lastMessageType: "template",
            direction: "outbound",
            markAsRead: true,
        });

        await emitMessageCreated(insertResult.insertId);
        await emitConversationUpdated(customer_id);

        res.json({ success: true, response: response.data });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: "Message failed" });
    }
};

exports.sendTextMessage = async (req, res) => {
    try {
        const { customer_id, phone, message } = req.body;

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: phone,
                type: "text",
                text: {
                    body: message,
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        // 💾 store message
        const [insertResult] = await db.query(
            `INSERT INTO messages 
            (customer_id, phone, message, message_type, type, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [customer_id, phone, message, "text", "outbound", "sent"]
        );

        // 🔄 update conversation
        await upsertConversationSummary({
            customerId: customer_id,
            lastMessage: message,
            lastMessageType: "text",
            direction: "outbound",
            markAsRead: true,
        });

        await emitMessageCreated(insertResult.insertId);
        await emitConversationUpdated(customer_id);

        res.json({ success: true });
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "Send failed" });
    }
};

async function handleGenericSend(req, res, forcedType = null) {
    try {
        const { customer_id, phone } = req.body;
        const outbound = buildWhatsAppMessagePayload(req, {
            ...req.body,
            ...(forcedType ? { type: forcedType } : {}),
        });

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
            outbound.payload,
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        const waMessageId = response.data?.messages?.[0]?.id || null;

        await persistOutboundMessage({
            customerId: customer_id,
            phone,
            preview: outbound.preview,
            messageType: outbound.messageType,
            mediaUrl: outbound.mediaUrl,
            mimeType: outbound.mimeType,
            fileName: outbound.fileName,
            waMessageId,
        });

        return res.json({ success: true, response: response.data });
    } catch (error) {
        console.error(error.response?.data || error.message);
        return res.status(error.statusCode || 500).json({
            error: error.message || "Send failed",
        });
    }
}

exports.sendMessage = async (req, res) => handleGenericSend(req, res);
exports.sendTextMessage = async (req, res) => handleGenericSend(req, res, "text");

function normalizeUploadType(type, mimeType = "") {
    const normalized = String(type || "").trim().toLowerCase();

    if (["image", "video", "audio", "document"].includes(normalized)) {
        return normalized;
    }

    if (["pdf", "file", "attachment"].includes(normalized)) {
        return "document";
    }

    if (mimeType.startsWith("image/")) {
        return "image";
    }

    if (mimeType.startsWith("video/")) {
        return "video";
    }

    if (mimeType.startsWith("audio/")) {
        return "audio";
    }

    return "document";
}

async function uploadFileToWhatsApp(file) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", fs.createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype,
    });

    const response = await axios.post(
        `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/media`,
        form,
        {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
        }
    );

    return response.data?.id || null;
}

async function sendTextOnly(req, res) {
    try {
        const { customer_id, phone, message } = req.body;

        if (!phone || !String(message || "").trim()) {
            return res.status(400).json({ error: "phone and message are required" });
        }

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: phone,
                type: "text",
                text: {
                    body: message,
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        const waMessageId = response.data?.messages?.[0]?.id || null;

        await persistOutboundMessage({
            customerId: customer_id,
            phone,
            preview: message,
            messageType: "text",
            mediaUrl: null,
            mimeType: null,
            fileName: null,
            waMessageId,
        });

        return res.json({ success: true, response: response.data });
    } catch (error) {
        console.error(error.response?.data || error.message);
        return res.status(error.statusCode || 500).json({
            error: error.message || "Send failed",
        });
    }
}

async function sendUploadedMessage(req, res) {
    try {
        const { customer_id, phone, caption } = req.body;
        const file = req.file;

        if (!phone || !file) {
            return res.status(400).json({ error: "phone and file are required" });
        }

        const messageType = normalizeUploadType(req.body.type, file.mimetype || "");
        const mediaId = await uploadFileToWhatsApp(file);

        if (!mediaId) {
            return res.status(500).json({ error: "WhatsApp media upload failed" });
        }

        const payload = {
            messaging_product: "whatsapp",
            to: phone,
            type: messageType,
            [messageType]: {
                id: mediaId,
            },
        };

        if (caption && ["image", "video", "document"].includes(messageType)) {
            payload[messageType].caption = caption;
        }

        if (messageType === "document" && file.originalname) {
            payload[messageType].filename = file.originalname;
        }

        const response = await axios.post(
            `https://graph.facebook.com/${process.env.FB_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        const waMessageId = response.data?.messages?.[0]?.id || null;
        const relativeMediaUrl = path.posix.join(
            "/uploads/outbound",
            path.basename(file.path)
        );

        await persistOutboundMessage({
            customerId: customer_id,
            phone,
            preview: buildMessagePreview({
                messageType,
                caption,
                fileName: file.originalname,
            }),
            messageType,
            mediaUrl: relativeMediaUrl,
            mimeType: file.mimetype || null,
            fileName: file.originalname || null,
            waMessageId,
        });

        return res.json({
            success: true,
            response: response.data,
            uploadedFile: {
                fileName: file.originalname,
                mimeType: file.mimetype,
                mediaUrl: relativeMediaUrl,
            },
        });
    } catch (error) {
        console.error(error.response?.data || error.message);
        return res.status(error.statusCode || 500).json({
            error: error.message || "Upload send failed",
        });
    }
}

exports.sendMessage = sendTextOnly;
exports.sendTextMessage = sendTextOnly;
exports.sendUploadMessage = sendUploadedMessage;
