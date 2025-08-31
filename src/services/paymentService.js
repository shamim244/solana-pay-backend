// ============================================
// Payment Service - Core Payment Logic
// ============================================

const { PublicKey, Keypair } = require('@solana/web3.js');
const { encodeURL } = require('@solana/pay');
const QRCode = require('qrcode');
const BigNumber = require('bignumber.js');
const { getMint } = require('@solana/spl-token');
const { pool } = require('../utils/database');
const { connection } = require('../utils/solana');
const config = require('../config');

// Helper function from original index.js
function getClientIp(req) {
  return req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown';
}

// Helper function from original index.js  
function formatTimeRemaining(seconds) {
  if (seconds <= 0) return 'Expired';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

// Payment status details from original index.js
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

class PaymentService {
  
  // Migrated from index.js line ~1470 (Universal Payment Request)
  async createPaymentRequest(data, apiKeyId, req) {
    const {
      recipient,
      amount,
      token_mint_address,
      label,
      message,
      memo,
      sessionId,
      payment_methods
    } = data;

    // Validation
    if (!recipient || !amount) {
      throw new Error('Missing required fields: recipient and amount');
    }

    if (amount < config.payment.minAmount || amount > config.payment.maxAmount) {
      throw new Error(`Amount must be between ${config.payment.minAmount} and ${config.payment.maxAmount}`);
    }

    // Validate recipient address
    try {
      new PublicKey(recipient);
    } catch (error) {
      throw new Error('Invalid recipient wallet address');
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
        // Check if token exists
        const [existingTokens] = await dbConn.query(
          'SELECT * FROM tokens WHERE mint_address = ?',
          [token_mint_address]
        );

        if (existingTokens.length > 0) {
          tokenId = existingTokens[0].id;
          tokenInfo = existingTokens[0];
        } else if (config.tokens.autoAddUnknownTokens) {
          // Auto-add unknown token
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
              apiKeyId
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
            throw new Error(`Invalid token mint address: ${error.message}`);
          }
        } else {
          await dbConn.rollback();
          throw new Error('Unknown token. Please add custom token first using /api/tokens/add-custom');
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
        apiKeyId,
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
      const { paymentMonitor } = require('./monitorService');
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

      // QR Code option - FIXED: Use qrcode package instead of @solana/pay createQR
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

        // Use qrcode package (server-side compatible)
        const qrSvg = await QRCode.toString(url.toString(), { 
          type: 'svg',
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });

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

      return response;

    } finally {
      dbConn.release();
    }
  }

  // Migrated from index.js - Get payment status
  async getPaymentStatus(reference) {
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
        return null;
      }

      const payment = payments[0];
      
      // Build comprehensive response
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
          fee_sol: payment.fee_lamports ? (payment.fee_lamports / 1000000000).toFixed(9) : null,
          slot: payment.slot,
          block_time: payment.block_time,
          confirmation_status: payment.confirmation_status
        };
      }

      return response;

    } finally {
      dbConn.release();
    }
  }

  // Get public payment status (no auth required)
  async getPublicPaymentStatus(reference) {
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
        return null;
      }

      const payment = payments[0];
      
      return {
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

    } finally {
      dbConn.release();
    }
  }

  // Cancel payment
  async cancelPayment(reference) {
    const dbConn = await pool.getConnection();
    
    try {
      const [result] = await dbConn.query(`
        UPDATE payments 
        SET status = 'cancelled', updated_at = NOW() 
        WHERE reference = ? AND status = 'pending'
      `, [reference]);

      if (result.affectedRows > 0) {
        // Stop monitoring
        const { paymentMonitor } = require('./monitorService');
        paymentMonitor.stopMonitoring(reference);
        
        // Send webhook
        const { sendWebhook } = require('./webhookService');
        await sendWebhook('payment.cancelled', { reference });
        
        return true;
      }
      
      return false;

    } finally {
      dbConn.release();
    }
  }

  // Get payment history
  async getPaymentHistory(queryParams) {
    const { limit = 50, offset = 0, status } = queryParams;
    const dbConn = await pool.getConnection();
    
    try {
      let query = 'SELECT * FROM payments WHERE 1=1';
      const params = [];
      
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));
      
      const [payments] = await dbConn.query(query, params);
      
      return {
        payments,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          returned: payments.length
        }
      };

    } finally {
      dbConn.release();
    }
  }
}

module.exports = new PaymentService();
