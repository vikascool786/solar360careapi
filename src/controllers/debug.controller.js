const fs = require("fs");
const path = require("path");
// const dotenv = require("dotenv");

function getDeclaredEnvKeys() {
  const envPath = path.join(process.cwd(), ".env");

  if (!fs.existsSync(envPath)) {
    return [];
  }

  const envFileContent = fs.readFileSync(envPath, "utf8");
  return Object.keys(dotenv.parse(envFileContent));
}

function mask(value) {
  if (!value) return null;
  if (value.length <= 6) return "******";
  return value.slice(0, 3) + "******" + value.slice(-3);
}

exports.getEnvironmentVariables = (req, res) => {
  try {
    const keys = [
      "NODE_ENV",
      "PORT",
      "APP_URL",
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD",
      "JWT_SECRET",
      "JWT_EXPIRATION",
      "SESSION_SECRET",
      "WHATSAPP_TOKEN",
      "WHATSAPP_PHONE_ID",
      "VERIFY_TOKEN",
      "WABA_ID",
      "META_APP_ID",
      "META_APP_SECRET",
      "META_REDIRECT_URI",
      "FRONTEND_META_CALLBACK_URL",
      "FRONTEND_URL",
      "FB_API_VERSION"
    ];

    const sensitiveKeys = new Set([
      "DB_PASSWORD",
      "JWT_SECRET",
      "SESSION_SECRET",
      "WHATSAPP_TOKEN",
      "META_APP_SECRET",
      "VERIFY_TOKEN"
    ]);

    const envValues = {};
    const missingKeys = [];

    keys.forEach((key) => {
      const value = process.env[key];

      if (value === undefined) {
        envValues[key] = null;
        missingKeys.push(key);
      } else {
        envValues[key] = sensitiveKeys.has(key) ? mask(String(value)) : value;
      }
    });

    res.json({
      success: true,
      totalDeclared: keys.length,
      loadedCount: keys.length - missingKeys.length,
      missingKeys,
      env: envValues,
      cwd: process.cwd()
    });
  } catch (error) {
    console.error("ENV DEBUG ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load environment variables",
      error: error.message
    });
  }
};