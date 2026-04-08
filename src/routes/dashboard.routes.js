const express = require("express");
const router = express.Router();
const controller = require("../controllers/dashboard.controller");

router.get("/", controller.getDashboardStats);
router.get("/upcoming", controller.getUpcomingServices);
router.get("/revenue", controller.getRevenueChart);

module.exports = router;