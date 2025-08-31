// ============================================
// System Routes (Health, Analytics, Webhooks)
// ============================================

const express = require('express');
const analyticsService = require('../services/analyticsService');
const webhookService = require('../services/webhookService');
const { pool, connection } = require('../utils/database');
const config = require('../config');

// Health Routes (Public)
const healthRoutes = express.Router();

healthRoutes.get('/', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    config: {
      network: config.solana.network,
      payment_timeout: `${config.payment.timeoutMinutes} minutes`
    }
  };
  
  res.json(health);
});

// Public Routes (No Auth)
const publicRoutes = express.Router();

publicRoutes.get('/payment-status/:reference', async (req, res) => {
  try {
    const paymentService = require('../services/paymentService');
    const result = await paymentService.getPublicPaymentStatus(req.params.reference);
    if (!result) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

// Analytics Routes (Protected)
const analyticsRoutes = express.Router();

analyticsRoutes.get('/summary', async (req, res) => {
  try {
    const result = await analyticsService.getSummary(req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

analyticsRoutes.get('/detailed', async (req, res) => {
  try {
    const result = await analyticsService.getDetailed(req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get detailed analytics' });
  }
});

// Webhook Routes (Protected)
const webhookRoutes = express.Router();

webhookRoutes.post('/configure', async (req, res) => {
  try {
    await webhookService.configureWebhook(req.body);
    res.json({ message: 'Webhook configured successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to configure webhook' });
  }
});

webhookRoutes.get('/list', async (req, res) => {
  try {
    const result = await webhookService.listWebhooks();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// Payment Management Routes (Protected)  
const paymentManagementRoutes = express.Router();

paymentManagementRoutes.get('/history', async (req, res) => {
  try {
    const paymentService = require('../services/paymentService');
    const result = await paymentService.getPaymentHistory(req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get payment history' });
  }
});

// System Config Routes (Protected)
const systemRoutes = express.Router();

systemRoutes.get('/config', async (req, res) => {
  try {
    const result = {
      environment: {
        node_env: config.server.nodeEnv,
        solana_network: config.solana.network,
        payment_timeout: config.payment.timeoutMinutes
      }
    };
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get system config' });
  }
});

module.exports = {
  healthRoutes,
  publicRoutes,
  analyticsRoutes,
  webhookRoutes,
  paymentManagementRoutes,
  systemRoutes
};
