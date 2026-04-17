const mysql = require('mysql2');

const pool = mysql.createPool({
  host: "localhost",
  user: "admin",
  password: "Poonam#@#1988",
  database: "solar360crm",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool.promise();
