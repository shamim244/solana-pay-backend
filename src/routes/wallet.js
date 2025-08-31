// ============================================
// Wallet Payment Routes - Updated to use WalletService
// ============================================

const express = require('express');
const router = express.Router();
const walletService = require('../services/walletService');

// Create transaction for direct wallet payment - Updated
router.post('/create-transaction', async (req, res) => {
  try {
    const result = await walletService.createWalletTransaction(req.body, req.apiKeyId);
    res.json(result);
  } catch (error) {
    console.error('Wallet transaction creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create wallet payment transaction',
      details: error.message 
    });
  }
});

// Submit signed transaction - Updated
router.post('/submit', async (req, res) => {
  try {
    const result = await walletService.submitSignedTransaction(req.body);
    if (!result) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Transaction submission error:', error);
    res.status(500).json({ 
      error: 'Transaction submission failed',
      details: error.message 
    });
  }
});

module.exports = router;
