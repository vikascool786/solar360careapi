function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getAllowedOrigins() {
  const envOrigins = [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_META_CALLBACK_URL,
    process.env.FRONTEND_ORIGIN,
    ...(process.env.FRONTEND_ORIGINS || "")
      .split(",")
      .map((value) => value.trim()),
  ];

  const localDevOrigins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
  ];

  return unique([...envOrigins, ...localDevOrigins]);
}

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }

  return getAllowedOrigins().includes(origin);
}

function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  };
}

module.exports = {
  buildCorsOptions,
  getAllowedOrigins,
  isOriginAllowed,
};
