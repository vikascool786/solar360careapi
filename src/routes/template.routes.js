const express = require("express");
const router = express.Router();
const controller = require("../controllers/template.controller");

router.get("/sync", controller.syncTemplates);
router.get("/", controller.getTemplates);

module.exports = router;