// src/routes/analytics.js
const express = require('express');
const router = express.Router();

router.get('/summary', (req, res) => {
  res.json({ message: 'Analytics route - Coming soon!' });
});

module.exports = router;
