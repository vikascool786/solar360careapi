const express = require("express");
const router = express.Router();
const serviceController = require("../controllers/service.controller");

router.get("/", serviceController.getAllVisits);
router.post("/generate-from-customers", serviceController.generateVisitsFromCustomers);
router.post("/create", serviceController.createServiceVisit);
router.post("/:id/complete", serviceController.completeService);
router.put("/:id/reschedule", serviceController.rescheduleService);
router.post("/plan", serviceController.createPlanVisits);
router.get("/:customer_id", serviceController.getServiceVisits);

module.exports = router;
