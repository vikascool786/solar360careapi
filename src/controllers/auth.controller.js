const db = require("../config/db");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { username, password } = req.body;

  const [[user]] = await db.query(
    "SELECT * FROM users WHERE username=?",
    [username]
  );

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    "SECRET_KEY",
    { expiresIn: "7d" }
  );

  res.json({ token, user });
};