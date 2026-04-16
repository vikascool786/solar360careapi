const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const router = express.Router();
const controller = require("../controllers/message.controller");

const uploadRoot = path.join(process.cwd(), "uploads", "outbound");
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadRoot),
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${sanitizedName}`);
  },
});

const upload = multer({ storage });

router.post("/send", controller.sendMessage);
router.post("/send-text", controller.sendTextMessage);
router.post("/send-upload", upload.single("file"), controller.sendUploadMessage);

module.exports = router;
