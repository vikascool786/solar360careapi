const express = require("express");
const router = express.Router();
const controller = require("../controllers/inbox.controller");

router.get("/conversations", controller.getConversations);
router.get("/messages/:customer_id", controller.getMessages);
router.patch("/conversations/:customer_id/read", controller.markConversationRead);

module.exports = router;
