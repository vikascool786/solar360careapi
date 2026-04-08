const express = require("express");
const router = express.Router();
const controller = require("../controllers/message.controller");

router.post("/send", controller.sendMessage);
router.post("/send-text", controller.sendTextMessage);

module.exports = router;