const express = require("express");
const router = express.Router();
const billingController = require("../controllers/billing.controller");

router.get("/invoices", billingController.getInvoices);
router.get("/customers/:customer_id/invoices", billingController.getCustomerInvoices);
router.get("/invoices/:invoice_id/payments", billingController.getInvoicePayments);
router.post("/invoices/:invoice_id/payments", billingController.addPayment);

module.exports = router;
