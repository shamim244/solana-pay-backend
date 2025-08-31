// ============================================
// Database Connection and Utilities
// ============================================

const mysql = require('mysql2/promise');

let config;
try {
  config = require('../config');
} catch (error) {
  console.error('Failed to load config:', error.message);
  process.exit(1);
}

const pool = mysql.createPool(config.database);

async function testDatabaseConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    console.log('✅ Database connected successfully');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    if (config.server.nodeEnv === 'production') {
      process.exit(1);
    }
    return false;
  }
}

module.exports = {
  pool,
  testDatabaseConnection
};
