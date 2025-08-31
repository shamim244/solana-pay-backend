// ============================================
// Payment Routes - Updated to use Services
// ============================================

const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');

// Create payment request (QR, Link, Wallet) - Updated
router.post('/request', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const result = await paymentService.createPaymentRequest(req.body, req.apiKeyId, req);
    res.json(result);
  } catch (error) {
    console.error('Payment request error:', error);
    
    // Log error (from original index.js)
    const responseTime = Date.now() - startTime;
    
    res.status(500).json({ 
      error: 'Failed to create payment request',
      details: error.message 
    });
  }
});

// Get payment status - Updated
router.get('/status/:reference', async (req, res) => {
  try {
    const result = await paymentService.getPaymentStatus(req.params.reference);
    if (!result) {
      return res.status(404).json({ 
        error: 'Payment not found',
        reference: req.params.reference 
      });
    }
    res.json(result);
  } catch (error) {
    console.error('Payment status error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

// Get payment history - Updated
router.get('/history', async (req, res) => {
  try {
    const result = await paymentService.getPaymentHistory(req.query);
    res.json(result);
  } catch (error) {
    console.error('Payment history error:', error);
    res.status(500).json({ error: 'Failed to get payment history' });
  }
});

// Cancel payment - Updated
router.post('/:reference/cancel', async (req, res) => {
  try {
    const result = await paymentService.cancelPayment(req.params.reference);
    if (!result) {
      return res.status(400).json({ error: 'Cannot cancel this payment' });
    }
    res.json({ message: 'Payment cancelled successfully' });
  } catch (error) {
    console.error('Payment cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel payment' });
  }
});

module.exports = router;
