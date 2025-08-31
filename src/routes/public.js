// ============================================
// Public Routes - No Authentication Required
// ============================================

const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');

// Public payment status (no auth required)
router.get('/payment-status/:reference', async (req, res) => {
  try {
    const result = await paymentService.getPublicPaymentStatus(req.params.reference);
    if (!result) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Public status error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

module.exports = router;
