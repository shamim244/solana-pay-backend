// ============================================
// Token Management Routes
// ============================================

const express = require('express');
const router = express.Router();
const tokenService = require('../services/tokenService');

// List all tokens
router.get('/list', async (req, res) => {
  try {
    const result = await tokenService.listTokens(req.query);
    res.json(result);
  } catch (error) {
    console.error('Token listing error:', error);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// Add custom token
router.post('/add-custom', async (req, res) => {
  try {
    const result = await tokenService.addCustomToken(req.body, req.apiKeyId);
    res.json(result);
  } catch (error) {
    console.error('Add token error:', error);
    res.status(500).json({ 
      error: 'Failed to add custom token',
      details: error.message 
    });
  }
});

// Get token info
router.get('/:mint_address/info', async (req, res) => {
  try {
    const result = await tokenService.getTokenInfo(req.params.mint_address);
    if (!result) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Token info error:', error);
    res.status(500).json({ error: 'Failed to get token info' });
  }
});

// Delete custom token
router.delete('/:mint_address', async (req, res) => {
  try {
    const result = await tokenService.deleteCustomToken(req.params.mint_address);
    if (!result) {
      return res.status(404).json({ error: 'Custom token not found' });
    }
    res.json({ message: 'Token deactivated successfully' });
  } catch (error) {
    console.error('Token deletion error:', error);
    res.status(500).json({ error: 'Failed to delete token' });
  }
});

module.exports = router;
