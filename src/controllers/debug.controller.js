const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function getDeclaredEnvKeys() {
  const envPath = path.join(process.cwd(), ".env");

  if (!fs.existsSync(envPath)) {
    return [];
  }

  const envFileContent = fs.readFileSync(envPath, "utf8");
  return Object.keys(dotenv.parse(envFileContent));
}

exports.getEnvironmentVariables = (req, res) => {
  try {
    const declaredKeys = getDeclaredEnvKeys();
    const envValues = {};

    declaredKeys.forEach((key) => {
      envValues[key] = process.env[key] ?? null;
    });

    res.json({
      success: true,
      envFileFound: declaredKeys.length > 0,
      totalDeclared: declaredKeys.length,
      loadedCount: declaredKeys.filter((key) => process.env[key] !== undefined)
        .length,
      missingKeys: declaredKeys.filter((key) => process.env[key] === undefined),
      env: envValues,
    });
  } catch (error) {
    console.error("ENV DEBUG ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load environment variables",
    });
  }
};
