// ============================================
// Solana Connection
// ============================================

const { Connection, clusterApiUrl } = require('@solana/web3.js');
const config = require('../config');

const connection = new Connection(
  config.solana.rpcUrl || clusterApiUrl(config.solana.network),
  config.solana.commitment
);

async function testSolanaConnection() {
  try {
    const version = await connection.getVersion();
    console.log(`✅ Solana connected successfully (${config.solana.network})`);
    if (config.logging.level === 'info') {
      console.log(`   Version: ${version['solana-core']}`);
    }
    return true;
  } catch (error) {
    console.error('❌ Solana connection failed:', error.message);
    if (config.server.nodeEnv === 'production') {
      process.exit(1);
    }
    return false;
  }
}

module.exports = {
  connection,
  testSolanaConnection
};
