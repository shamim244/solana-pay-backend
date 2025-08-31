// ============================================
// Configuration Loader - SIMPLIFIED (No Notifications)
// ============================================

require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'UNIVERSAL_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    console.log('Please set this in your .env file');
    process.exit(1);
  }
}

const config = {
  // Server Configuration
  server: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    trustProxy: process.env.TRUST_PROXY === 'true',
    maxPayloadSize: process.env.MAX_PAYLOAD_SIZE || '1mb'
  },

  // Database Configuration
  database: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'solana_pay_db',
    port: parseInt(process.env.DB_PORT) || 3306,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    waitForConnections: true,
    queueLimit: 0
  },

  // API Configuration
  api: {
    universalApiKey: process.env.UNIVERSAL_API_KEY
  },

  // Solana Configuration
  solana: {
    network: process.env.SOLANA_NETWORK || 'mainnet-beta',
    rpcUrl: process.env.SOLANA_RPC_URL,
    commitment: process.env.SOLANA_COMMITMENT || 'confirmed'
  },

  // Payment Configuration
  payment: {
    timeoutMinutes: parseInt(process.env.PAYMENT_TIMEOUT_MINUTES) || 5,
    checkIntervalSeconds: parseInt(process.env.PAYMENT_CHECK_INTERVAL_SECONDS) || 10,
    initialDelaySeconds: parseInt(process.env.PAYMENT_INITIAL_DELAY_SECONDS) || 60,
    batchSize: parseInt(process.env.PAYMENT_BATCH_SIZE) || 20,
    maxAmount: parseFloat(process.env.PAYMENT_MAX_AMOUNT) || 1000000,
    minAmount: parseFloat(process.env.PAYMENT_MIN_AMOUNT) || 0.000001
  },

  // Rate Limiting Configuration
  rateLimiting: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  },

  // Monitoring Configuration
  monitoring: {
    enablePaymentMonitoring: process.env.ENABLE_PAYMENT_MONITORING !== 'false',
    enablePollingMonitoring: process.env.ENABLE_POLLING_MONITORING !== 'false'
  },

  // Webhook Configuration
  webhooks: {
    enabled: process.env.ENABLE_WEBHOOKS !== 'false',
    timeoutSeconds: parseInt(process.env.WEBHOOK_TIMEOUT_SECONDS) || 30,
    retryAttempts: parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS) || 3
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableApiLogging: process.env.ENABLE_API_LOGGING !== 'false',
    enableErrorLogging: process.env.ENABLE_ERROR_LOGGING !== 'false',
    enablePaymentLogging: process.env.ENABLE_PAYMENT_LOGGING !== 'false'
  },

  // Token Configuration
  tokens: {
    allowCustomTokens: process.env.ALLOW_CUSTOM_TOKENS !== 'false',
    autoAddUnknownTokens: process.env.AUTO_ADD_UNKNOWN_TOKENS !== 'false'
  },

  // Health Check Configuration
  health: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false'
  },

  // Development Configuration
  development: {
    debugMode: process.env.DEBUG_MODE === 'true'
  }
};

console.log('✅ Configuration loaded successfully');

module.exports = config;
