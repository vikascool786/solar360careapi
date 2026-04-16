const express = require("express");
const router = express.Router();
const controller = require("../controllers/webhook.controller");

router.get("/media/:mediaId", controller.getMedia);
router.get("/", controller.verifyWebhook);
router.post("/", controller.receiveMessage);

module.exports = router;
