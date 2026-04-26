const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { initializeSocket } = require("./socket");
const { buildCorsOptions } = require("./config/cors");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors(buildCorsOptions()));
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get('/', (req, res) => {
  res.send('Solar360Care CRM API running');
});

// routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/dashboard", require("./routes/dashboard.routes"));
app.use('/api/customers', require('./routes/customer.routes'));
app.use('/api/messages', require('./routes/message.routes'));
app.use("/api/service-visits", require("./routes/service.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/webhook", require("./routes/webhook.routes"));
app.use("/api/inbox", require("./routes/inbox.routes"));
app.use("/api/campaigns", require("./routes/campaign.routes"));
app.use("/api/templates", require("./routes/template.routes"));
app.use("/api/debug", require("./routes/debug.routes"));

// cron job running
require('./services/reminderService'); // start the reminder service

const PORT = process.env.PORT || 5004;

initializeSocket(server);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
