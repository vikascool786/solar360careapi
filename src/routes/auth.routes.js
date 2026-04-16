const router = require("express").Router();
const { login, facebookLogin, facebookCallback } = require("../controllers/auth.controller");

router.post("/login", login);
router.get("/facebook", facebookLogin);
router.get("/facebook/callback", facebookCallback);

module.exports = router;