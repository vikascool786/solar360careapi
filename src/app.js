const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Solar360Care CRM API running');
});

// routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/dashboard", require("./routes/dashboard.routes"));
app.use('/api/customers', require('./routes/customer.routes'));
app.use('/api/messages', require('./routes/message.routes'));
app.use("/api/service-visits", require("./routes/service.routes"));
app.use("/api/webhook", require("./routes/webhook.routes"));
app.use("/api/inbox", require("./routes/inbox.routes"));
app.use("/api/campaigns", require("./routes/campaign.routes"));
app.use("/api/templates", require("./routes/template.routes"));

// cron job running
require('./services/reminderService'); // start the reminder service

const PORT = process.env.PORT || 5004;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});