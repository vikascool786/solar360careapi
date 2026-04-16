const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "SECRET_KEY";

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7).trim();
}

function requireAuthenticatedUser(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error("Authorization token is required");
    error.statusCode = 401;
    throw error;
  }

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    error.statusCode = 401;
    error.message = "Invalid authorization token";
    throw error;
  }
}

function requireAuthenticatedUserId(req) {
  const user = requireAuthenticatedUser(req);

  if (!user?.id) {
    const error = new Error("Authenticated user id is missing");
    error.statusCode = 401;
    throw error;
  }

  return user.id;
}

module.exports = {
  getBearerToken,
  requireAuthenticatedUser,
  requireAuthenticatedUserId,
  JWT_SECRET,
};
