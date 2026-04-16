const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { buildCorsOptions } = require("./config/cors");

const JWT_SECRET = process.env.JWT_SECRET || "SECRET_KEY";

let ioInstance = null;

function normalizeBearerToken(token = "") {
  if (!token) {
    return null;
  }

  return token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
}

function initializeSocket(server) {
  ioInstance = new Server(server, {
    cors: buildCorsOptions(),
  });

  ioInstance.use((socket, next) => {
    const token = normalizeBearerToken(socket.handshake.auth?.token);

    if (!token) {
      socket.user = null;
      return next();
    }

    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (error) {
      return next(new Error("Invalid socket token"));
    }
  });

  ioInstance.on("connection", (socket) => {
    socket.join("inbox");

    if (socket.user?.id) {
      socket.join(`user:${socket.user.id}`);
    }

    socket.on("conversation:join", (customerId) => {
      if (!customerId) {
        return;
      }

      socket.join(`conversation:${customerId}`);
    });

    socket.on("conversation:leave", (customerId) => {
      if (!customerId) {
        return;
      }

      socket.leave(`conversation:${customerId}`);
    });
  });

  return ioInstance;
}

function getIO() {
  if (!ioInstance) {
    throw new Error("Socket.IO has not been initialized");
  }

  return ioInstance;
}

module.exports = {
  initializeSocket,
  getIO,
};
