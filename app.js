// ============================================
// Solana Pay Backend - Express App Setup
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const config = require('./src/config');

// Import middleware
const authMiddleware = require('./src/middleware/auth');
const rateLimitMiddleware = require('./src/middleware/rateLimit');
const loggerMiddleware = require('./src/middleware/logger');

// Import routes
const healthRoutes = require('./src/routes/health');
const paymentRoutes = require('./src/routes/payment');
const walletRoutes = require('./src/routes/wallet');
const tokenRoutes = require('./src/routes/token');
const analyticsRoutes = require('./src/routes/analytics');
const webhookRoutes = require('./src/routes/webhook');

// Initialize monitoring service
require('./src/services/monitorService');

const app = express();

// ============================================
// Middleware Setup
// ============================================

app.use(cors({ 
  origin: config.server.corsOrigin,
  credentials: true 
}));

app.use(bodyParser.json({ 
  limit: config.server.maxPayloadSize 
}));

app.use(bodyParser.urlencoded({ 
  extended: true, 
  limit: config.server.maxPayloadSize 
}));

// Trust proxy if configured
if (config.server.trustProxy) {
  app.set('trust proxy', true);
}

// Global middleware
app.use(loggerMiddleware.requestTiming);
app.use(loggerMiddleware.responseLogging);

// ============================================
// Routes Setup
// ============================================

// Public routes (no authentication required)
app.use('/health', healthRoutes);

// Protected routes (require authentication and rate limiting)
app.use('/api', authMiddleware, rateLimitMiddleware);

// Mount API routes
app.use('/api/payment', paymentRoutes);
app.use('/api/wallet-payment', walletRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhooks', webhookRoutes);

// Public status endpoint (no auth)
app.use('/public', require('./src/routes/public'));

// ============================================
// Error Handling
// ============================================

// Global error handler
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  
  if (error.name === 'ValidationError') {
    return res.status(400).json({ error: error.message });
  }
  
  if (error.name === 'SolanaError') {
    return res.status(503).json({ error: 'Blockchain connection issue' });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    details: config.development?.debugMode ? error.message : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    method: req.method,
    path: req.originalUrl,
    available_endpoints: {
      health: 'GET /health',
      payment: 'POST /api/payment/request',
      wallet: 'POST /api/wallet-payment/create-transaction',
      tokens: 'GET /api/tokens/list',
      analytics: 'GET /api/analytics/summary'
    }
  });
});



module.exports = app;
