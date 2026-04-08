const express = require("express");
const router = express.Router();
const controller = require("../controllers/campaign.controller");

router.post("/send", controller.sendCampaign);

module.exports = router;