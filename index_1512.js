// ============================================
// Solana Pay Backend - Complete Implementation
// Universal Payment Gateway Service
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// Solana Pay & Web3 Dependencies
const { 
  Connection, 
  clusterApiUrl, 
  PublicKey, 
  Keypair, 
  Transaction, 
  TransactionInstruction, 
  SystemProgram,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

const { 
  encodeURL, 
  createQR, 
  findReference, 
  validateTransfer 
} = require('@solana/pay');

const {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint
} = require('@solana/spl-token');

const BigNumber = require('bignumber.js');

// Load Configuration
const config = require('./config');

// ============================================
// Express App Setup
// ============================================

const app = express();

// Middleware
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

// ============================================
// Database & Solana Connection
// ============================================

const pool = mysql.createPool(config.database);
const connection = new Connection(
  config.solana.rpcUrl || clusterApiUrl(config.solana.network),
  config.solana.commitment
);

// Test connections
async function testDatabaseConnection() {
  try {
    const dbConn = await pool.getConnection();
    await dbConn.query('SELECT 1');
    dbConn.release();
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    if (config.server.nodeEnv === 'production') {
      process.exit(1);
    }
  }
}

async function testSolanaConnection() {
  try {
    const version = await connection.getVersion();
    console.log(`✅ Solana connected successfully (${config.solana.network})`);
  } catch (error) {
    console.error('❌ Solana connection failed:', error.message);
    if (config.server.nodeEnv === 'production') {
      process.exit(1);
    }
  }
}

// ============================================
// Utility Functions
// ============================================

function getClientIp(req) {
  return req.ip || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         'unknown';
}

function formatTimeRemaining(seconds) {
  if (seconds <= 0) return 'Expired';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

async function getTokenId(mintAddress) {
  const dbConn = await pool.getConnection();
  try {
    const [rows] = await dbConn.query(
      'SELECT id FROM tokens WHERE mint_address = ?',
      [mintAddress]
    );
    return rows.length > 0 ? rows[0].id : null;
  } finally {
    dbConn.release();
  }
}

// ============================================
// Middleware Functions
// ============================================

// Authentication Middleware
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authorization header required. Format: Bearer YOUR_API_KEY' 
      });
    }

    const apiKey = authHeader.split('Bearer ')[1];
    if (!apiKey || apiKey !== config.api.universalApiKey) {
      return res.status(401).json({ 
        error: 'Invalid API key' 
      });
    }

    req.apiKeyId = 1; // Universal API key always has ID 1
    next();
  } catch (error) {
    res.status(500).json({ 
      error: 'Authentication failed',
      details: error.message 
    });
  }
}

// Rate Limiting Middleware
const rateLimitStore = new Map();

function rateLimitMiddleware(req, res, next) {
  if (!config.rateLimiting.maxRequests) {
    return next();
  }

  const key = req.apiKeyId || getClientIp(req);
  const now = Date.now();
  const windowMs = config.rateLimiting.windowMs;
  const maxRequests = config.rateLimiting.maxRequests;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs
    });
    return next();
  }

  const store = rateLimitStore.get(key);
  
  if (now > store.resetTime) {
    store.count = 1;
    store.resetTime = now + windowMs;
    return next();
  }

  if (store.count >= maxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit: maxRequests,
      reset_time: new Date(store.resetTime).toISOString(),
      retry_after: Math.ceil((store.resetTime - now) / 1000)
    });
  }

  store.count++;
  next();
}

// ============================================
// Payment Status Helper Function
// ============================================

function getPaymentStatusDetails(payment) {
  const now = new Date();
  const expiresAt = new Date(payment.expires_at);
  
  switch (payment.status) {
    case 'pending':
      const timeLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));
      return {
        message: 'Payment is waiting for completion',
        time_left_seconds: timeLeft,
        time_left_formatted: formatTimeRemaining(timeLeft),
        is_expired: timeLeft === 0,
        next_check: `Checking every ${config.payment.checkIntervalSeconds} seconds`
      };
      
    case 'submitted':
      return {
        message: 'Transaction submitted to blockchain, waiting for confirmation',
        status: 'processing'
      };
      
    case 'validated':
      return {
        message: 'Payment completed successfully',
        completion_time: payment.validated_at,
        funds_status: 'Transferred to recipient wallet',
        confirmations: 'Confirmed on Solana blockchain'
      };
      
    case 'failed':
      return {
        message: 'Payment failed to complete',
        reason: payment.error_message || 'Transaction validation failed',
        funds_status: 'No funds were transferred',
        retry_possible: 'You can create a new payment request'
      };
      
    case 'expired':
      return {
        message: 'Payment request expired',
        expired_at: payment.expires_at,
        time_expired: Math.floor((now - expiresAt) / 1000),
        funds_status: 'No funds were transferred',
        retry_possible: 'You can create a new payment request'
      };
      
    case 'cancelled':
      return {
        message: 'Payment was cancelled',
        cancelled_at: payment.updated_at,
        funds_status: 'No funds were transferred'
      };
      
    default:
      return {
        message: 'Unknown payment status',
        contact_support: true
      };
  }
}

// ============================================
// Webhook Service
// ============================================

async function sendWebhook(eventType, payload, paymentId = null, transactionId = null) {
  if (!config.webhooks.enabled) return;

  const dbConn = await pool.getConnection();
  try {
    await dbConn.query(`
      INSERT INTO webhooks (event_type, payment_id, transaction_id, payload)
      VALUES (?, ?, ?, ?)
    `, [eventType, paymentId, transactionId, JSON.stringify(payload)]);
  } catch (error) {
    console.error('Failed to store webhook event:', error.message);
  } finally {
    dbConn.release();
  }
}

// ============================================
// Payment Monitoring Service
// ============================================

class PaymentMonitor {
  constructor() {
    this.activePayments = new Map();
  }

  startMonitoring(reference, paymentData) {
    this.activePayments.set(reference, {
      ...paymentData,
      startTime: Date.now(),
      lastCheck: null
    });
  }

  stopMonitoring(reference) {
    this.activePayments.delete(reference);
  }

  getCheckInterval(paymentAgeSeconds) {
    if (paymentAgeSeconds < config.payment.initialDelaySeconds) return null;
    if (paymentAgeSeconds < 120) return 30;
    if (paymentAgeSeconds < 240) return 15;
    return config.payment.checkIntervalSeconds;
  }
}

const paymentMonitor = new PaymentMonitor();

// Update payment as completed
async function updatePaymentAsCompleted(payment, signature) {
  const dbConn = await pool.getConnection();
  
  try {
    await dbConn.beginTransaction();

    // Get transaction details
    let txInfo = null;
    try {
      txInfo = await connection.getTransaction(signature, { commitment: 'confirmed' });
    } catch (error) {
      console.log('Could not fetch transaction details:', error.message);
    }

    // Update payment status
    await dbConn.query(`
      UPDATE payments 
      SET status = 'validated', validated_at = NOW(), updated_at = NOW() 
      WHERE id = ?
    `, [payment.id]);

    // Create transaction record
    const fromWallet = txInfo?.transaction?.message?.accountKeys?.[0]?.toString() || 'unknown';
    
    await dbConn.query(`
      INSERT INTO transactions (
        payment_id, signature, from_wallet, to_wallet, amount, 
        spl_token_id, fee_lamports, slot, block_time, 
        confirmation_status, status, raw_transaction
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'success', ?)
    `, [
      payment.id,
      signature,
      fromWallet,
      payment.recipient_wallet,
      payment.amount,
      payment.spl_token_id,
      txInfo?.meta?.fee || null,
      txInfo?.slot || null,
      txInfo?.blockTime ? new Date(txInfo.blockTime * 1000) : null,
      txInfo ? JSON.stringify(txInfo) : null
    ]);

    await dbConn.commit();

    // Send webhook
    await sendWebhook('payment.completed', {
      payment_id: payment.id,
      reference: payment.reference,
      amount: payment.amount,
      signature: signature,
      recipient_wallet: payment.recipient_wallet,
      status: 'completed'
    }, payment.id);

    if (config.logging.enablePaymentLogging) {
      console.log(`✅ Payment completed: ${payment.reference} (${signature})`);
    }

  } catch (error) {
    await dbConn.rollback();
    console.error('Error updating completed payment:', error);
  } finally {
    dbConn.release();
  }
}

// Batch check multiple payments
async function batchCheckPayments(payments) {
  if (config.logging.level === 'debug') {
    console.log(`🔍 Checking ${payments.length} payments...`);
  }
  
  for (const payment of payments) {
    try {
      const refKey = new PublicKey(payment.reference);
      
      // Find transaction with reference
      const signature = await findReference(connection, refKey, { 
        finality: config.solana.commitment
      });
      
      if (signature) {
        // Validate transaction
        const isValid = await validateTransfer(connection, signature, {
          recipient: new PublicKey(payment.recipient_wallet),
          amount: new BigNumber(payment.amount),
          splToken: payment.token_mint ? new PublicKey(payment.token_mint) : undefined,
          reference: refKey
        });

        if (isValid) {
          await updatePaymentAsCompleted(payment, signature);
          paymentMonitor.stopMonitoring(payment.reference);
        }
      }
      
      // Update last check time
      const activePayment = paymentMonitor.activePayments.get(payment.reference);
      if (activePayment) {
        activePayment.lastCheck = Date.now();
      }
      
    } catch (error) {
      if (config.logging.level === 'debug') {
        console.log(`Payment ${payment.reference} still pending:`, error.message);
      }
    }
  }
}

// Optimized payment detection
async function optimizedPaymentDetection() {
  if (!config.monitoring.enablePaymentMonitoring || !config.monitoring.enablePollingMonitoring) {
    return;
  }

  const now = Date.now();
  const dbConn = await pool.getConnection();
  
  try {
    const [pendingPayments] = await dbConn.query(`
      SELECT p.*, t.mint_address as token_mint 
      FROM payments p
      LEFT JOIN tokens t ON p.spl_token_id = t.id 
      WHERE p.status IN ('pending', 'submitted')
      AND p.created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
      AND p.expires_at > NOW()
      LIMIT ?
    `, [config.payment.timeoutMinutes, config.payment.batchSize]);

    const paymentsToCheck = [];
    
    for (const payment of pendingPayments) {
      const paymentAge = (now - new Date(payment.created_at).getTime()) / 1000;
      const shouldCheck = paymentMonitor.getCheckInterval(paymentAge);
      
      if (shouldCheck !== null) {
        const lastCheck = paymentMonitor.activePayments.get(payment.reference)?.lastCheck;
        
        if (!lastCheck || (now - lastCheck) >= (shouldCheck * 1000)) {
          paymentsToCheck.push(payment);
        }
      }
    }

    // Batch check payments
    if (paymentsToCheck.length > 0) {
      await batchCheckPayments(paymentsToCheck);
    }

    // Clean up expired payments
    const [expiredPayments] = await dbConn.query(`
      SELECT reference FROM payments 
      WHERE status IN ('pending', 'submitted') AND expires_at <= NOW()
    `);
    
    if (expiredPayments.length > 0) {
      for (const payment of expiredPayments) {
        paymentMonitor.stopMonitoring(payment.reference);
      }
      
      await dbConn.query(`
        UPDATE payments 
        SET status = 'expired', updated_at = NOW() 
        WHERE status IN ('pending', 'submitted') AND expires_at <= NOW()
      `);
      
      if (config.logging.enablePaymentLogging) {
        console.log(`🧹 Cleaned up ${expiredPayments.length} expired payments`);
      }
    }
    
  } catch (error) {
    console.error('Payment detection error:', error.message);
  } finally {
    dbConn.release();
  }
}

// Schedule payment detection
cron.schedule(`*/${config.payment.checkIntervalSeconds} * * * * *`, optimizedPaymentDetection);

// ============================================
// API Routes
// ============================================

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {},
    config: {
      network: config.solana.network,
      payment_timeout: `${config.payment.timeoutMinutes} minutes`,
      monitoring_enabled: config.monitoring.enablePaymentMonitoring
    }
  };
  
  // Check database
  if (config.healthCheck.enabled) {
    try {
      const dbConn = await pool.getConnection();
      await dbConn.query('SELECT 1');
      dbConn.release();
      health.services.database = 'healthy';
    } catch (error) {
      health.services.database = 'unhealthy';
      health.status = 'degraded';
    }
    
    // Check Solana RPC
    try {
      await connection.getEpochInfo();
      health.services.solana_rpc = 'healthy';
    } catch (error) {
      health.services.solana_rpc = 'unhealthy';
      health.status = 'degraded';
    }
  } else {
    health.services.database = 'not_checked';
    health.services.solana_rpc = 'not_checked';
  }
  
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Apply authentication and rate limiting to protected routes
app.use('/api', authenticate, rateLimitMiddleware);

// ============================================
// Payment Generation Endpoints
// ============================================

// Universal Payment Request (All Methods: QR, Link, Wallet)
app.post('/api/payment-request', async (req, res) => {
  try {
    const { 
      recipient, 
      amount, 
      token_mint_address,
      label, 
      message, 
      memo, 
      sessionId,
      payment_methods 
    } = req.body;

    // Validation
    if (!recipient || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: recipient and amount' 
      });
    }

    if (amount < config.payment.minAmount || amount > config.payment.maxAmount) {
      return res.status(400).json({ 
        error: `Amount must be between ${config.payment.minAmount} and ${config.payment.maxAmount}` 
      });
    }

    // Validate recipient address
    try {
      new PublicKey(recipient);
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid recipient wallet address' 
      });
    }

    const refKey = new Keypair().publicKey;
    const paymentAmount = new BigNumber(amount);
    const expiresAt = new Date(Date.now() + config.payment.timeoutMinutes * 60 * 1000);

    const dbConn = await pool.getConnection();
    
    try {
      await dbConn.beginTransaction();

      let tokenId = null;
      let tokenInfo = null;

      // Handle custom token
      if (token_mint_address && config.tokens.allowCustomTokens) {
        const [existingTokens] = await dbConn.query(
          'SELECT * FROM tokens WHERE mint_address = ?',
          [token_mint_address]
        );

        if (existingTokens.length > 0) {
          tokenId = existingTokens[0].id;
          tokenInfo = existingTokens[0];
        } else if (config.tokens.autoAddUnknownTokens) {
          try {
            const mintInfo = await getMint(connection, new PublicKey(token_mint_address));
            
            const [result] = await dbConn.query(`
              INSERT INTO tokens (
                mint_address, symbol, name, decimals, is_active, is_custom, added_by_api_key_id
              ) VALUES (?, ?, ?, ?, true, true, ?)
            `, [
              token_mint_address,
              `TOKEN_${token_mint_address.slice(0, 8)}`,
              'Auto-added Custom Token',
              mintInfo.decimals,
              req.apiKeyId
            ]);
            
            tokenId = result.insertId;
            tokenInfo = {
              id: tokenId,
              mint_address: token_mint_address,
              symbol: `TOKEN_${token_mint_address.slice(0, 8)}`,
              name: 'Auto-added Custom Token',
              decimals: mintInfo.decimals
            };
            
          } catch (error) {
            await dbConn.rollback();
            return res.status(400).json({ 
              error: 'Invalid token mint address',
              details: error.message 
            });
          }
        } else {
          await dbConn.rollback();
          return res.status(400).json({ 
            error: 'Unknown token. Please add custom token first using /api/tokens/add-custom' 
          });
        }
      }

      // Create session if provided
      let sessionDbId = null;
      if (sessionId) {
        const [sessionResult] = await dbConn.query(`
          INSERT INTO payment_sessions (session_id, client_ip, user_agent, metadata)
          VALUES (?, ?, ?, ?)
        `, [
          sessionId,
          getClientIp(req),
          req.get('User-Agent') || 'unknown',
          JSON.stringify({ payment_methods })
        ]);
        sessionDbId = sessionResult.insertId;
      }

      // Store payment
      const [paymentResult] = await dbConn.query(`
        INSERT INTO payments (
          reference, api_key_id, payment_type, amount, spl_token_id, 
          recipient_wallet, label, message, memo, session_id, expires_at
        ) VALUES (?, ?, 'multi_method', ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        refKey.toBase58(), 
        req.apiKeyId, 
        paymentAmount.toNumber(), 
        tokenId,
        recipient, 
        label, 
        message, 
        memo, 
        sessionDbId, 
        expiresAt
      ]);

      await dbConn.commit();

      // Start monitoring
      paymentMonitor.startMonitoring(refKey.toBase58(), {
        id: paymentResult.insertId,
        amount: paymentAmount.toNumber(),
        recipient_wallet: recipient,
        token_mint: token_mint_address
      });

      // Build response
      const response = {
        reference: refKey.toBase58(),
        expires_at: expiresAt.toISOString(),
        timeout_minutes: config.payment.timeoutMinutes,
        payment_options: {}
      };

      if (tokenInfo) {
        response.token_info = {
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          mint_address: tokenInfo.mint_address,
          decimals: tokenInfo.decimals
        };
      }

      // Generate payment options
      const includeQR = !payment_methods || payment_methods.includes('qr');
      const includeLink = !payment_methods || payment_methods.includes('link');
      const includeWallet = !payment_methods || payment_methods.includes('wallet');

      // QR Code option
      if (includeQR) {
        const url = encodeURL({
          recipient: new PublicKey(recipient),
          amount: paymentAmount,
          splToken: token_mint_address ? new PublicKey(token_mint_address) : undefined,
          reference: refKey,
          label, 
          message, 
          memo
        });

        const qrCode = createQR(url);
        const qrSvg = await qrCode.getRawData('svg');

        // Store QR in database
        await dbConn.query(
          'UPDATE payments SET qr_code_svg = ? WHERE id = ?',
          [qrSvg, paymentResult.insertId]
        );

        response.payment_options.qr_code = {
          url: url.toString(),
          qr_svg: qrSvg,
          instructions: `Scan with your Solana wallet to pay ${amount} ${tokenInfo?.symbol || 'SOL'}`
        };
      }

      // Payment Link option
      if (includeLink) {
        const paymentUrl = `${req.protocol}://${req.get('host')}/pay/${refKey.toBase58()}`;
        response.payment_options.payment_link = {
          url: paymentUrl,
          instructions: `Click to open payment page and pay ${amount} ${tokenInfo?.symbol || 'SOL'}`
        };
      }

      // Direct Wallet option
      if (includeWallet) {
        response.payment_options.direct_wallet = {
          supported: true,
          instructions: `Connect your wallet to pay ${amount} ${tokenInfo?.symbol || 'SOL'}`,
          token_required: token_mint_address,
          token_name: tokenInfo?.name || 'SOL'
        };
      }

      res.json(response);

    } catch (error) {
      await dbConn.rollback();
      throw error;
    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Payment request error:', error);
    res.status(500).json({ 
      error: 'Failed to create payment request',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// ============================================
// Direct Wallet Payment Endpoints
// ============================================

// Create transaction for wallet payment
app.post('/api/wallet-payment/create-transaction', async (req, res) => {
  try {
    const { 
      recipient, 
      amount, 
      token_mint_address, 
      label, 
      message, 
      memo, 
      payer_wallet,
      sessionId 
    } = req.body;

    // Validation
    if (!payer_wallet) {
      return res.status(400).json({ 
        error: 'Payer wallet address required' 
      });
    }

    if (!recipient || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: recipient and amount' 
      });
    }

    // Validate addresses
    try {
      new PublicKey(payer_wallet);
      new PublicKey(recipient);
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid wallet address format' 
      });
    }

    const refKey = new Keypair().publicKey;
    const paymentAmount = new BigNumber(amount);
    const expiresAt = new Date(Date.now() + config.payment.timeoutMinutes * 60 * 1000);

    const dbConn = await pool.getConnection();
    
    try {
      // Get or create token record
      let tokenId = null;
      if (token_mint_address) {
        tokenId = await getTokenId(token_mint_address);
        if (!tokenId && config.tokens.autoAddUnknownTokens) {
          const mintInfo = await getMint(connection, new PublicKey(token_mint_address));
          const [result] = await dbConn.query(`
            INSERT INTO tokens (mint_address, symbol, name, decimals, is_active, is_custom, added_by_api_key_id)
            VALUES (?, ?, ?, ?, true, true, ?)
          `, [
            token_mint_address,
            `TOKEN_${token_mint_address.slice(0, 8)}`,
            'Auto-added Token',
            mintInfo.decimals,
            req.apiKeyId
          ]);
          tokenId = result.insertId;
        }
      }

      // Store payment
      const [result] = await dbConn.query(`
        INSERT INTO payments (
          reference, api_key_id, payment_type, amount, spl_token_id, 
          recipient_wallet, sender_wallet, label, message, memo, expires_at
        ) VALUES (?, ?, 'wallet_direct', ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        refKey.toBase58(), 
        req.apiKeyId, 
        paymentAmount.toNumber(), 
        tokenId,
        recipient, 
        payer_wallet, 
        label, 
        message, 
        memo, 
        expiresAt
      ]);

      // Create transaction
      const payerPublicKey = new PublicKey(payer_wallet);
      const recipientPublicKey = new PublicKey(recipient);
      
      const { blockhash } = await connection.getLatestBlockhash();
      const transaction = new Transaction({ 
        recentBlockhash: blockhash,
        feePayer: payerPublicKey 
      });

      if (token_mint_address) {
        // SPL Token transfer
        const mint = new PublicKey(token_mint_address);
        const senderATA = await getAssociatedTokenAddress(mint, payerPublicKey);
        const recipientATA = await getAssociatedTokenAddress(mint, recipientPublicKey);
        
        const mintInfo = await getMint(connection, mint);
        const transferInstruction = createTransferCheckedInstruction(
          senderATA,
          mint,
          recipientATA,
          payerPublicKey,
          BigInt(paymentAmount.multipliedBy(10 ** mintInfo.decimals).toString()),
          mintInfo.decimals
        );
        transaction.add(transferInstruction);
      } else {
        // SOL transfer
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: payerPublicKey,
          toPubkey: recipientPublicKey,
          lamports: paymentAmount.multipliedBy(LAMPORTS_PER_SOL).toNumber()
        });
        transaction.add(transferInstruction);
      }

      // Add reference instruction
      transaction.add(
        new TransactionInstruction({
          keys: [{ pubkey: refKey, isSigner: false, isWritable: false }],
          data: memo ? Buffer.from(memo, 'utf8') : Buffer.alloc(0),
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
        })
      );

      // Serialize transaction
      const serializedTransaction = transaction.serialize({ 
        requireAllSignatures: false,
        verifySignatures: false 
      }).toString('base64');

      res.json({
        payment_id: result.insertId,
        reference: refKey.toBase58(),
        transaction: serializedTransaction,
        expires_at: expiresAt.toISOString(),
        message: message || `Pay ${amount} ${token_mint_address ? 'tokens' : 'SOL'} to ${label || 'merchant'}`
      });

    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Wallet payment creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create wallet payment transaction',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// Submit signed transaction
app.post('/api/wallet-payment/submit', async (req, res) => {
  try {
    const { reference, signed_transaction } = req.body;

    if (!reference || !signed_transaction) {
      return res.status(400).json({ 
        error: 'Missing required fields: reference and signed_transaction' 
      });
    }

    const dbConn = await pool.getConnection();
    
    try {
      // Get payment details
      const [payments] = await dbConn.query(
        'SELECT * FROM payments WHERE reference = ? AND payment_type = "wallet_direct"',
        [reference]
      );

      if (payments.length === 0) {
        return res.status(404).json({ 
          error: 'Payment not found' 
        });
      }

      const payment = payments[0];
      if (payment.status !== 'pending') {
        return res.status(400).json({ 
          error: 'Payment already processed',
          current_status: payment.status 
        });
      }

      // Submit transaction
      const transactionBuffer = Buffer.from(signed_transaction, 'base64');
      
      const signature = await connection.sendRawTransaction(transactionBuffer, {
        skipPreflight: false,
        preflightCommitment: config.solana.commitment,
        maxRetries: 3
      });

      // Update payment status
      await dbConn.query(`
        UPDATE payments 
        SET status = 'submitted', updated_at = NOW() 
        WHERE reference = ?
      `, [reference]);

      // Start monitoring
      paymentMonitor.startMonitoring(reference, {
        id: payment.id,
        amount: payment.amount,
        recipient_wallet: payment.recipient_wallet,
        signature: signature
      });

      res.json({
        signature: signature,
        explorer_url: `https://solscan.io/tx/${signature}`,
        status: 'submitted',
        message: 'Transaction submitted successfully. Waiting for confirmation...'
      });

    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Transaction submission error:', error);
    res.status(500).json({ 
      error: 'Transaction submission failed',
      details: error.message 
    });
  }
});

// ============================================
// Payment Status Endpoints
// ============================================

// Get payment status (authenticated)
app.get('/api/payment-status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const dbConn = await pool.getConnection();
    
    try {
      const [payments] = await dbConn.query(`
        SELECT 
          p.*,
          t.signature,
          t.from_wallet,
          t.to_wallet,
          t.fee_lamports,
          t.slot,
          t.block_time,
          t.confirmation_status,
          t.status as transaction_status,
          token.symbol as token_symbol,
          token.name as token_name,
          token.mint_address as token_mint,
          token.decimals as token_decimals
        FROM payments p
        LEFT JOIN transactions t ON p.id = t.payment_id
        LEFT JOIN tokens token ON p.spl_token_id = token.id
        WHERE p.reference = ?
      `, [reference]);

      if (payments.length === 0) {
        return res.status(404).json({ 
          error: 'Payment not found',
          reference: reference
        });
      }

      const payment = payments[0];
      
      const response = {
        reference: payment.reference,
        status: payment.status,
        payment_type: payment.payment_type,
        
        amount: {
          value: parseFloat(payment.amount),
          currency: payment.token_symbol || 'SOL',
          currency_name: payment.token_name || 'Solana',
          token_mint: payment.token_mint || null,
          decimals: payment.token_decimals || 9
        },
        
        wallets: {
          recipient: payment.recipient_wallet,
          sender: payment.from_wallet || payment.sender_wallet || null
        },
        
        metadata: {
          label: payment.label,
          message: payment.message,
          memo: payment.memo
        },
        
        timestamps: {
          created_at: payment.created_at,
          expires_at: payment.expires_at,
          validated_at: payment.validated_at,
          updated_at: payment.updated_at
        },
        
        transaction: null,
        status_details: getPaymentStatusDetails(payment)
      };

      // Add transaction details if available
      if (payment.status === 'validated' && payment.signature) {
        response.transaction = {
          signature: payment.signature,
          explorer_url: `https://solscan.io/tx/${payment.signature}`,
          from_wallet: payment.from_wallet,
          to_wallet: payment.to_wallet,
          fee_lamports: payment.fee_lamports,
          fee_sol: payment.fee_lamports ? (payment.fee_lamports / LAMPORTS_PER_SOL).toFixed(9) : null,
          slot: payment.slot,
          block_time: payment.block_time,
          confirmation_status: payment.confirmation_status
        };
      }

      res.json(response);

    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Payment status error:', error);
    res.status(500).json({ 
      error: 'Failed to get payment status',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// Public payment status (no authentication required)
app.get('/public/payment-status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const dbConn = await pool.getConnection();
    
    try {
      const [payments] = await dbConn.query(`
        SELECT 
          p.reference, p.status, p.amount, p.recipient_wallet, p.label, p.message,
          p.created_at, p.expires_at, p.validated_at,
          t.signature, t.block_time,
          token.symbol as token_symbol, token.name as token_name
        FROM payments p
        LEFT JOIN transactions t ON p.id = t.payment_id
        LEFT JOIN tokens token ON p.spl_token_id = token.id
        WHERE p.reference = ?
      `, [reference]);

      if (payments.length === 0) {
        return res.status(404).json({ 
          error: 'Payment not found' 
        });
      }

      const payment = payments[0];
      
      const response = {
        reference: payment.reference,
        status: payment.status,
        amount: parseFloat(payment.amount),
        currency: payment.token_symbol || 'SOL',
        currency_name: payment.token_name || 'Solana',
        label: payment.label,
        message: payment.message,
        created_at: payment.created_at,
        expires_at: payment.expires_at,
        validated_at: payment.validated_at,
        transaction: payment.signature ? {
          signature: payment.signature,
          explorer_url: `https://solscan.io/tx/${payment.signature}`,
          confirmed_at: payment.block_time
        } : null,
        status_details: getPaymentStatusDetails(payment)
      };

      res.json(response);

    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Public status error:', error);
    res.status(500).json({ 
      error: 'Failed to get payment status'
    });
  }
});

// ============================================
// Token Management Endpoints
// ============================================

// Add custom token
app.post('/api/tokens/add-custom', async (req, res) => {
  try {
    const { mint_address, symbol, name, decimals, logo_url, description } = req.body;

    if (!mint_address) {
      return res.status(400).json({ 
        error: 'Mint address is required' 
      });
    }

    // Validate mint address
    try {
      new PublicKey(mint_address);
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid mint address format' 
      });
    }

    const dbConn = await pool.getConnection();
    
    try {
      // Validate mint exists on-chain
      const mintInfo = await getMint(connection, new PublicKey(mint_address));
      
      // Check if token already exists
      const [existing] = await dbConn.query(
        'SELECT id FROM tokens WHERE mint_address = ?', 
        [mint_address]
      );

      if (existing.length > 0) {
        return res.json({ 
          message: 'Token already exists',
          token_id: existing[0].id 
        });
      }

      // Add token to database
      const [result] = await dbConn.query(`
        INSERT INTO tokens (
          mint_address, symbol, name, decimals, logo_url, 
          is_active, is_custom, added_by_api_key_id, description
        ) VALUES (?, ?, ?, ?, ?, true, true, ?, ?)
      `, [
        mint_address, 
        symbol || `TOKEN_${mint_address.slice(0, 8)}`,
        name || 'Custom Token',
        decimals !== undefined ? decimals : mintInfo.decimals,
        logo_url,
        req.apiKeyId,
        description
      ]);

      res.json({
        token_id: result.insertId,
        mint_address,
        symbol: symbol || `TOKEN_${mint_address.slice(0, 8)}`,
        name: name || 'Custom Token',
        decimals: decimals !== undefined ? decimals : mintInfo.decimals,
        supply: mintInfo.supply.toString(),
        message: 'Custom token added successfully'
      });

    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Error adding custom token:', error);
    res.status(500).json({ 
      error: 'Failed to add custom token',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// List all tokens
app.get('/api/tokens/list', async (req, res) => {
  try {
    const { include_custom = 'true' } = req.query;
    
    const dbConn = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          id, mint_address, symbol, name, decimals, logo_url, 
          is_custom, description, created_at
        FROM tokens 
        WHERE is_active = true
      `;
      
      if (include_custom === 'false') {
        query += ' AND is_custom = false';
      }
      
      query += ' ORDER BY is_custom ASC, symbol ASC';
      
      const [tokens] = await dbConn.query(query);
      
      res.json({
        tokens: tokens,
        count: tokens.length
      });
      
    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Error listing tokens:', error);
    res.status(500).json({ 
      error: 'Failed to list tokens',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// Get payment history
app.get('/api/payments/history', async (req, res) => {
  try {
    const { 
      status, 
      from_date, 
      to_date, 
      limit = 50, 
      offset = 0,
      currency 
    } = req.query;

    const dbConn = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          p.reference,
          p.status,
          p.amount,
          p.recipient_wallet,
          p.label,
          p.created_at,
          p.validated_at,
          t.signature,
          token.symbol as currency
        FROM payments p
        LEFT JOIN transactions t ON p.id = t.payment_id
        LEFT JOIN tokens token ON p.spl_token_id = token.id
        WHERE 1=1
      `;
      
      const params = [];
      
      if (status) {
        query += ` AND p.status = ?`;
        params.push(status);
      }
      
      if (from_date) {
        query += ` AND p.created_at >= ?`;
        params.push(from_date);
      }
      
      if (to_date) {
        query += ` AND p.created_at <= ?`;
        params.push(to_date);
      }
      
      if (currency) {
        query += ` AND token.symbol = ?`;
        params.push(currency);
      }
      
      query += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), parseInt(offset));
      
      const [payments] = await dbConn.query(query, params);
      
      // Get total count
      let countQuery = `
        SELECT COUNT(*) as total
        FROM payments p
        LEFT JOIN tokens token ON p.spl_token_id = token.id
        WHERE 1=1
      `;
      const countParams = params.slice(0, -2); // Remove limit and offset
      
      if (status) countQuery += ` AND p.status = ?`;
      if (from_date) countQuery += ` AND p.created_at >= ?`;
      if (to_date) countQuery += ` AND p.created_at <= ?`;
      if (currency) countQuery += ` AND token.symbol = ?`;
      
      const [countResult] = await dbConn.query(countQuery, countParams);
      
      res.json({
        payments: payments,
        pagination: {
          total: countResult[0].total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + payments.length) < countResult[0].total
        }
      });
      
    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Error getting payment history:', error);
    res.status(500).json({ 
      error: 'Failed to get payment history',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// Analytics endpoint
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const dbConn = await pool.getConnection();
    
    try {
      const [stats] = await dbConn.query(`
        SELECT 
          COUNT(*) as total_payments,
          SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END) as successful_payments,
          SUM(CASE WHEN status = 'validated' THEN amount ELSE 0 END) as total_volume,
          AVG(CASE WHEN status = 'validated' THEN TIMESTAMPDIFF(SECOND, created_at, validated_at) END) as avg_completion_time
        FROM payments
        WHERE created_at BETWEEN ? AND ?
      `, [start_date || '2020-01-01', end_date || new Date().toISOString()]);
      
      res.json(stats[0]);
      
    } finally {
      dbConn.release();
    }

  } catch (error) {
    console.error('Error getting analytics:', error);
    res.status(500).json({ 
      error: 'Failed to get analytics',
      details: config.development.debugMode ? error.message : 'Internal server error'
    });
  }
});

// ============================================
// Error Handling
// ============================================

// Global error handler
app.use((error, req, res, next) => {
  console.error('API Error:', error);
  
  if (error.name === 'ValidationError') {
    res.status(400).json({ error: error.message });
  } else if (error.name === 'SolanaError') {
    res.status(503).json({ error: 'Blockchain connection issue' });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /health',
      'POST /api/payment-request',
      'POST /api/wallet-payment/create-transaction',
      'POST /api/wallet-payment/submit',
      'GET /api/payment-status/:reference',
      'GET /public/payment-status/:reference',
      'POST /api/tokens/add-custom',
      'GET /api/tokens/list',
      'GET /api/payments/history',
      'GET /api/analytics/summary'
    ]
  });
});

// ============================================
// Server Startup
// ============================================

app.listen(config.server.port, async () => {
  console.log(`🚀 Solana Pay Backend Server Started`);
  console.log(`   Port: ${config.server.port}`);
  console.log(`   Network: ${config.solana.network}`);
  console.log(`   Environment: ${config.server.nodeEnv}`);
  console.log(`   Payment Timeout: ${config.payment.timeoutMinutes} minutes`);
  console.log(`   Monitoring: ${config.monitoring.enablePaymentMonitoring ? 'Enabled' : 'Disabled'}`);
  
  // Test connections
  await testDatabaseConnection();
  await testSolanaConnection();
  
  console.log('✅ All systems ready!');
});

// Export app for testing
module.exports = app;
