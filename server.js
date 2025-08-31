// ============================================
// Solana Pay Backend - Server Entry Point
// ============================================

require('dotenv').config();

const app = require('./app');
const config = require('./src/config');
const { testDatabaseConnection } = require('./src/utils/database');
const { testSolanaConnection } = require('./src/utils/solana');

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  // Stop cron jobs
  const cron = require('node-cron');
  cron.destroy();
  
  // Close database connections
  const { pool } = require('./src/utils/database');
  await pool.end();
  
  console.log('✅ Graceful shutdown completed');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
async function startServer() {
  try {
    // Test connections
    await testDatabaseConnection();
    await testSolanaConnection();
    
    // Start server
    const server = app.listen(config.server.port, () => {
      console.log('🚀 Solana Pay Backend Server Started');
      console.log(`   Port: ${config.server.port}`);
      console.log(`   Network: ${config.solana.network}`);
      console.log(`   Environment: ${config.server.nodeEnv}`);
      console.log(`   API URL: http://localhost:${config.server.port}/health`);
      console.log('✅ All systems ready! Backend is fully operational.');
    });

    // Handle server errors
    server.on('error', (error) => {
      console.error('❌ Server error:', error);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
