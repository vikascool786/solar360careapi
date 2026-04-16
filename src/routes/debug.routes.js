const express = require("express");
const router = express.Router();
const controller = require("../controllers/debug.controller");

router.get("/env", controller.getEnvironmentVariables);

module.exports = router;
