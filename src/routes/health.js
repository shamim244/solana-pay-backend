// ============================================
// Health Check Route - FIXED VERSION
// ============================================

const express = require('express');
const router = express.Router();
const config = require('../config');

// Database connection test
async function testDatabaseConnection() {
  try {
    const { pool } = require('../utils/database');
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return 'healthy';
  } catch (error) {
    console.error('Database health check failed:', error.message);
    return 'unhealthy';
  }
}

// Solana RPC connection test
async function testSolanaConnection() {
  try {
    const { connection } = require('../utils/solana');
    const version = await connection.getVersion();
    return version ? 'healthy' : 'unhealthy';
  } catch (error) {
    console.error('Solana health check failed:', error.message);
    return 'unhealthy';
  }
}

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    // Only run health checks if enabled (default to true if not specified)
    const healthEnabled = config.health?.enabled !== false;
    
    if (!healthEnabled) {
      return res.json({
        status: 'disabled',
        timestamp: new Date().toISOString()
      });
    }

    // Run health checks
    const databaseStatus = await testDatabaseConnection();
    const solanaStatus = await testSolanaConnection();
    
    const overall = (databaseStatus === 'healthy' && solanaStatus === 'healthy') ? 'ok' : 'degraded';

    res.json({
      status: overall,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: databaseStatus,
        solana_rpc: solanaStatus
      },
      config: {
        network: config.solana?.network || 'unknown',
        payment_timeout: `${config.payment?.timeoutMinutes || 5} minutes`,
        monitoring_enabled: config.monitoring?.enablePaymentMonitoring !== false
      }
    });

  } catch (error) {
    console.error('Health check error:', error);
    
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
      details: config.development?.debugMode ? error.message : undefined
    });
  }
});

module.exports = router;
