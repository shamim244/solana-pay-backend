// src/routes/webhook.js
const express = require('express');
const router = express.Router();

router.post('/configure', (req, res) => {
  res.json({ message: 'Webhook route - Coming soon!' });
});

module.exports = router;
