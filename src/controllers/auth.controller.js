const db = require("../config/db");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "SECRET_KEY";

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7).trim();
}

function resolveUserIdFromState(state) {
  if (!state) {
    return null;
  }

  try {
    const decoded = jwt.verify(state, JWT_SECRET);
    return decoded.id || null;
  } catch (error) {
    return null;
  }
}

function getFrontendCallbackUrl() {
  return (
    process.env.FRONTEND_META_CALLBACK_URL ||
    process.env.FRONTEND_URL ||
    "http://localhost:3000"
  );
}

exports.login = async (req, res) => {
  const { username, password } = req.body;

  const [[user]] = await db.query("SELECT * FROM users WHERE username=?", [
    username,
  ]);

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" },
  );

  res.json({ token, user });
};

exports.facebookLogin = async (req, res) => {
  const token = getBearerToken(req);
  let state;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      state = jwt.sign({ id: decoded.id }, JWT_SECRET, { expiresIn: "15m" });
    } catch (error) {
      return res.status(401).json({ error: "Invalid authorization token" });
    }
  }

  const url =
    "https://www.facebook.com/v19.0/dialog/oauth?" +
    new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_REDIRECT_URI,
      scope:
        "whatsapp_business_management,whatsapp_business_messaging,business_management",
      response_type: "code",
      ...(state ? { state } : {}),
    }).toString();

  res.redirect(url);
};

exports.facebookCallback = async (req, res) => {
  try {
    const code = req.query.code;
    const userIdFromState = resolveUserIdFromState(req.query.state);

    // 1. Exchange code for access token
    const tokenRes = await axios.get(
      `https://graph.facebook.com/${process.env.FB_API_VERSION}/oauth/access_token`,
      {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: process.env.META_REDIRECT_URI,
          code,
        },
      },
    );

    const access_token = tokenRes.data.access_token;

    // 2. Get businesses
    const businessRes = await axios.get(
      `https://graph.facebook.com/${process.env.FB_API_VERSION}/me/businesses`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    const businesses = businessRes.data.data;

    // 3. Get WABA for the first business (if exists)
    const wabaRes = await axios.get(
      `https://graph.facebook.com/${process.env.FB_API_VERSION}/${businesses[0].id}/owned_whatsapp_business_accounts`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    const wabas = wabaRes.data.data;

    // 4. phone number
    const phoneRes = await axios.get(
      `https://graph.facebook.com/${process.env.FB_API_VERSION}/${wabas[0].id}/phone_numbers`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    const phones = phoneRes.data.data;

    // Assume logged-in user (IMPORTANT)
    const userId = userIdFromState || req.user?.id || 1;

    // const businesses = req.body.businesses || [];
    // const wabas = req.body.wabas || [];
    // const phones = req.body.phones || [];

    // Save business+  Check if business exists
    const [existing] = await db.query(
      "SELECT id FROM businesses WHERE meta_business_id=?",
      [businesses[0].id],
    );

    let businessId;

    if (existing.length > 0) {
      businessId = existing[0].id;
    } else {
      const [result] = await db.query(
        "INSERT INTO businesses (user_id, meta_business_id, name) VALUES (?, ?, ?)",
        [userId, businesses[0].id, businesses[0].name],
      );
      businessId = result.insertId;
    }

    // Save WABA + Check if WABA exists
    const [existingWaba] = await db.query(
      "SELECT id FROM whatsapp_accounts WHERE waba_id=?",
      [wabas[0].id],
    );

    let whatsappAccountId;

    if (existingWaba.length > 0) {
      whatsappAccountId = existingWaba[0].id;

      // Update token (IMPORTANT)
      await db.query(
        "UPDATE whatsapp_accounts SET business_id=?, user_id=?, access_token=?, name=? WHERE id=?",
        [businessId, userId, access_token, wabas[0].name, whatsappAccountId],
      );
    } else {
      const [wabaResult] = await db.query(
        "INSERT INTO whatsapp_accounts (business_id, waba_id, name, access_token, user_id) VALUES (?, ?, ?, ?, ?)",
        [businessId, wabas[0].id, wabas[0].name, access_token, userId],
      );

      whatsappAccountId = wabaResult.insertId;
    }

    await db.query(
      "UPDATE whatsapp_accounts SET business_id=?, user_id=?, access_token=? WHERE id=?",
      [businessId, userId, access_token, whatsappAccountId],
    );

    // Save phone
    // Check if phone exists
    const [existingPhone] = await db.query(
      "SELECT id FROM phone_numbers WHERE phone_number_id=?",
      [phones[0].id],
    );

    if (existingPhone.length > 0) {
      // Update if needed
      await db.query(
        `UPDATE phone_numbers 
     SET whatsapp_account_id=?, user_id=?, display_number=?, verified_name=? 
     WHERE phone_number_id=?`,
        [
          whatsappAccountId,
          userId,
          phones[0].display_phone_number,
          phones[0].verified_name,
          phones[0].id,
        ],
      );
    } else {
      await db.query(
        `INSERT INTO phone_numbers 
     (whatsapp_account_id, phone_number_id, display_number, verified_name, user_id) 
     VALUES (?, ?, ?, ?, ?)`,
        [
          whatsappAccountId,
          phones[0].id,
          phones[0].display_phone_number,
          phones[0].verified_name,
          userId,
        ],
      );
    }

    const frontendCallbackUrl = new URL(getFrontendCallbackUrl());
    frontendCallbackUrl.searchParams.set("success", "1");
    frontendCallbackUrl.searchParams.set("businessId", String(businessId));
    frontendCallbackUrl.searchParams.set(
      "whatsappAccountId",
      String(whatsappAccountId),
    );
    frontendCallbackUrl.searchParams.set(
      "phoneNumberId",
      String(phones[0].id),
    );

    return res.redirect(frontendCallbackUrl.toString());
  } catch (err) {
    console.error(err.response?.data || err.message);
    const frontendCallbackUrl = new URL(getFrontendCallbackUrl());
    frontendCallbackUrl.searchParams.set("success", "0");
    frontendCallbackUrl.searchParams.set("error", "facebook_auth_failed");

    return res.redirect(frontendCallbackUrl.toString());
  }
};
