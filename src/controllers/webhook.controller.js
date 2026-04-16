const axios = require("axios");
const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const { upsertConversationSummary } = require("../services/conversation.service");
const {
    emitConversationUpdated,
    emitMessageCreated,
    emitMessageStatusUpdate,
} = require("../services/inboxRealtime.service");

const MEDIA_STORAGE_MODE = process.env.WHATSAPP_MEDIA_MODE || "local";
const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "whatsapp");

function ensureUploadDirectory() {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

function getFileExtension(mimeType = "", fallbackName = "") {
    const mimeMap = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "video/mp4": ".mp4",
        "video/3gpp": ".3gp",
        "audio/aac": ".aac",
        "audio/amr": ".amr",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/ogg": ".ogg",
        "application/pdf": ".pdf",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "text/plain": ".txt",
    };

    if (mimeMap[mimeType]) {
        return mimeMap[mimeType];
    }

    return path.extname(fallbackName || "") || "";
}

function sanitizeFileName(fileName = "") {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function getAccessTokenByReceiverPhoneId(phoneNumberId) {
    if (!phoneNumberId) {
        return null;
    }

    const [[row]] = await db.query(
        `SELECT wa.access_token
         FROM phone_numbers pn
         JOIN whatsapp_accounts wa ON wa.id = pn.whatsapp_account_id
         WHERE pn.phone_number_id = ?
         LIMIT 1`,
        [phoneNumberId]
    );

    return row?.access_token || null;
}


async function getCustomerOwnerByReceiverPhoneId(phoneNumberId) {
    if (!phoneNumberId) {
        return null;
    }

    const [[row]] = await db.query(
        `SELECT
            wa.id AS whatsapp_account_id,
            wa.user_id
         FROM phone_numbers pn
         JOIN whatsapp_accounts wa ON wa.id = pn.whatsapp_account_id
         WHERE pn.phone_number_id = ?
         LIMIT 1`,
        [phoneNumberId]
    );

    return row || null;
}
async function resolveMediaUrl(mediaId, accessToken) {
    if (!mediaId || !accessToken) {
        return null;
    }

    try {
        const response = await axios.get(
            `https://graph.facebook.com/v22.0/${mediaId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        return response.data?.url || null;
    } catch (error) {
        console.error("MEDIA URL FETCH ERROR:", error.response?.data || error.message);
        return null;
    }
}

async function downloadWhatsAppMedia(mediaId, accessToken, mimeType, fileName) {
    const mediaUrl = await resolveMediaUrl(mediaId, accessToken);

    if (!mediaUrl) {
        return null;
    }

    ensureUploadDirectory();

    const extension = getFileExtension(mimeType, fileName);
    const safeFileName =
        sanitizeFileName(fileName) || `${mediaId}${extension || ""}`;
    const storedFileName =
        path.extname(safeFileName) ? safeFileName : `${safeFileName}${extension}`;
    const relativePath = path.posix.join("/uploads/whatsapp", storedFileName);
    const absolutePath = path.join(UPLOAD_ROOT, storedFileName);

    const response = await axios.get(mediaUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        responseType: "stream",
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(absolutePath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });

    return relativePath;
}

async function resolveStoredMediaPath(mediaPayload, receiverPhoneNumberId) {
    const mediaId = mediaPayload?.id;

    if (!mediaId) {
        return null;
    }

    const accessToken = await getAccessTokenByReceiverPhoneId(receiverPhoneNumberId);

    if (!accessToken) {
        return `/api/webhook/media/${mediaId}?phone_number_id=${receiverPhoneNumberId}`;
    }

    if (MEDIA_STORAGE_MODE === "proxy") {
        return `/api/webhook/media/${mediaId}?phone_number_id=${receiverPhoneNumberId}`;
    }

    try {
        return await downloadWhatsAppMedia(
            mediaId,
            accessToken,
            mediaPayload?.mime_type,
            mediaPayload?.filename
        );
    } catch (error) {
        console.error("MEDIA DOWNLOAD ERROR:", error.response?.data || error.message);
        return `/api/webhook/media/${mediaId}?phone_number_id=${receiverPhoneNumberId}`;
    }
}

async function getIncomingMessageDetails(message, receiverPhoneNumberId) {
    const messageType = message?.type || "text";
    const baseDetails = {
        messageType,
        text: "",
        mediaUrl: null,
        mimeType: null,
        fileName: null,
        rawPayload: JSON.stringify(message || {}),
        latitude: null,
        longitude: null,
        contactName: null,
        contactPhone: null,
    };

    if (messageType === "text") {
        return {
            ...baseDetails,
            messageType: "text",
            text: message.text?.body || "",
        };
    }

    if (messageType === "location") {
        const location = message.location || {};
        const locationText = [location.name, location.address]
            .filter(Boolean)
            .join(", ");

        return {
            ...baseDetails,
            messageType: "location",
            text: locationText || "[Location]",
            latitude: location.latitude || null,
            longitude: location.longitude || null,
        };
    }

    if (messageType === "contacts") {
        const contact = message.contacts?.[0] || {};
        const contactName = contact?.name?.formatted_name || "[Contact]";
        const contactPhone =
            contact?.phones?.[0]?.phone ||
            contact?.phones?.[0]?.wa_id ||
            null;

        return {
            ...baseDetails,
            messageType: "contacts",
            text: contactName,
            contactName: contactName === "[Contact]" ? null : contactName,
            contactPhone,
        };
    }

    if (messageType === "button") {
        return {
            ...baseDetails,
            messageType: "button",
            text: message.button?.text || "[Button reply]",
        };
    }

    if (messageType === "interactive") {
        const interactive = message.interactive || {};
        const interactiveText =
            interactive.button_reply?.title ||
            interactive.list_reply?.title ||
            interactive.nfm_reply?.body ||
            "[Interactive reply]";

        return {
            ...baseDetails,
            messageType: "interactive",
            text: interactiveText,
        };
    }

    if (messageType === "reaction") {
        return {
            ...baseDetails,
            messageType: "reaction",
            text: message.reaction?.emoji || "[Reaction]",
        };
    }

    const mediaPayload = message[messageType] || {};
    const mediaUrl = await resolveStoredMediaPath(mediaPayload, receiverPhoneNumberId);
    const caption = mediaPayload.caption || "";

    const previewMap = {
        image: caption || "[Image]",
        video: caption || "[Video]",
        audio: "[Audio]",
        document: caption || mediaPayload.filename || "[Document]",
        sticker: "[Sticker]",
    };

    return {
        ...baseDetails,
        messageType,
        text: previewMap[messageType] || caption || `[${messageType}]`,
        mediaUrl,
        mimeType: mediaPayload.mime_type || null,
        fileName: mediaPayload.filename || null,
    };
}

// ✅ STEP 3A — VERIFY WEBHOOK
exports.verifyWebhook = (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("VERIFY HIT", token === VERIFY_TOKEN);

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified");
        return res.status(200).send(challenge);
    } else {
        return res.sendStatus(403);
    }
};

// ✅ STEP 3B — RECEIVE MESSAGE
exports.receiveMessage = async (req, res) => {
    console.log("WEBHOOK HIT: received message");
    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;

        // 🔥 1. HANDLE STATUS UPDATES (UPGRADED)
        if (value?.statuses) {
            const statusObj = value.statuses[0];

            const status = statusObj.status; // sent, delivered, read, failed
            const messageId = statusObj.id;
            const phone = statusObj.recipient_id;
            const phone10 = phone ? phone.slice(-10) : null;
            let customerId = null;

            let error = null;

            if (status === "failed") {
                error = JSON.stringify(statusObj.errors || null);
            }

            const [result] = await db.query(
                `UPDATE campaign_logs 
                 SET 
                   status = ?,
                   error = ?,
                   response = ?,
                   last_attempt_at = NOW()
                WHERE message_id = ?`,
                [status, error, JSON.stringify(statusObj), messageId]
            );

            if (phone10) {
                const [[customer]] = await db.query(
                    "SELECT id FROM customers WHERE RIGHT(phone, 10) = ? LIMIT 1",
                    [phone10]
                );

                customerId = customer?.id || null;
            }

            // 🔥 fallback if message_id not found
            if (result.affectedRows === 0) {
                console.log("⚠️ message_id not found, fallback to phone");

                await db.query(
                    `UPDATE campaign_logs 
                     SET 
                       status = ?,
                       error = ?,
                       response = ?,
                       last_attempt_at = NOW()
                     WHERE RIGHT(phone, 10) = ?
                     AND message_id IS NULL
                     ORDER BY id DESC
                     LIMIT 1`,
                    [status, error, JSON.stringify(statusObj), phone10]
                );
            }

            emitMessageStatusUpdate({
                customerId,
                messageId,
                phone,
                status,
                error,
                rawStatus: statusObj,
            });

            // 🔍 Debug if no row updated
            if (result.affectedRows === 0) {
                console.log("⚠️ No row found for message_id:", messageId);
            }

            return res.sendStatus(200);
        }

        // 🔥 2. HANDLE INCOMING USER MESSAGES (ENHANCED)

        const message = value?.messages?.[0];

        if (!message) {
            return res.sendStatus(200);
        }

        const phone = message.from;
        const receiverPhoneNumberId = value?.metadata?.phone_number_id;
        const incomingMessage = await getIncomingMessageDetails(
            message,
            receiverPhoneNumberId
        );

        console.log("📩 MESSAGE RECEIVED:", value);

        // 🔍 Normalize phone (IMPORTANT FIX)
        const phone10 = phone.slice(-10);

        const ownerContext = await getCustomerOwnerByReceiverPhoneId(receiverPhoneNumberId);

        if (!ownerContext?.user_id) {
            console.error("CUSTOMER OWNER RESOLUTION ERROR:", receiverPhoneNumberId);
            return res.sendStatus(200);
        }

        const [customers] = await db.query(
            "SELECT * FROM customers WHERE RIGHT(phone, 10) = ? AND user_id = ? LIMIT 1",
            [phone10, ownerContext.user_id]
        );

        let customer_id;

        if (customers.length > 0) {
            customer_id = customers[0].id;

            if (!customers[0].whatsapp_account_id && ownerContext.whatsapp_account_id) {
                await db.query(
                    "UPDATE customers SET whatsapp_account_id = ? WHERE id = ? AND user_id = ?",
                    [ownerContext.whatsapp_account_id, customer_id, ownerContext.user_id]
                );
            }
        } else {
            const [result] = await db.query(
                `INSERT INTO customers 
            (user_id, whatsapp_account_id, name, phone, customer_type, plan_type, payment_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    ownerContext.user_id,
                    ownerContext.whatsapp_account_id,
                    phone,
                    phone,
                    "lead",
                    "lead",
                    "pending",
                ]
            );

            customer_id = result.insertId;
        }

        // save message
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
                media_url,
                mime_type,
                file_name,
                wa_message_id,
                raw_payload,
                latitude,
                longitude,
                contact_name,
                contact_phone,
                created_at
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                customer_id,
                phone,
                incomingMessage.text,
                incomingMessage.messageType,
                "inbound",
                "received",
                message.id || null,
                incomingMessage.mediaUrl,
                incomingMessage.mimeType,
                incomingMessage.fileName,
                message.id || null,
                incomingMessage.rawPayload,
                incomingMessage.latitude,
                incomingMessage.longitude,
                incomingMessage.contactName,
                incomingMessage.contactPhone,
            ]
        );

        // 🔄 update conversation
        await upsertConversationSummary({
            customerId: customer_id,
            lastMessage: incomingMessage.text,
            lastMessageType: incomingMessage.messageType,
            direction: "inbound",
        });

        await emitMessageCreated(insertResult.insertId);
        await emitConversationUpdated(customer_id);

        // 🔥 3. MARK CAMPAIGN AS REPLIED (NEW FEATURE)
        await db.query(
            `UPDATE campaign_logs
             SET 
               replied = 1,
               replied_at = NOW(),
               status = IF(status != 'failed', 'replied', status)
             WHERE RIGHT(phone, 10) = ?
             ORDER BY id DESC
             LIMIT 1`,
            [phone10]
        );

        res.sendStatus(200);

    } catch (err) {
        console.error("WEBHOOK ERROR:", err);
        res.sendStatus(500);
    }
};

exports.getMedia = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const phoneNumberId = req.query.phone_number_id;

        if (!mediaId || !phoneNumberId) {
            return res.status(400).json({ error: "mediaId and phone_number_id are required" });
        }

        const accessToken = await getAccessTokenByReceiverPhoneId(phoneNumberId);

        if (!accessToken) {
            return res.status(404).json({ error: "Access token not found" });
        }

        const mediaMeta = await axios.get(
            `https://graph.facebook.com/v22.0/${mediaId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        const fileResponse = await axios.get(mediaMeta.data?.url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            responseType: "stream",
        });

        if (mediaMeta.data?.mime_type) {
            res.setHeader("Content-Type", mediaMeta.data.mime_type);
        }

        if (mediaMeta.data?.sha256) {
            res.setHeader("ETag", mediaMeta.data.sha256);
        }

        fileResponse.data.pipe(res);
    } catch (error) {
        console.error("MEDIA PROXY ERROR:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to load media" });
    }
};

