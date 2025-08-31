// ============================================
// Payment Monitoring Service - Complete Migration
// ============================================

const { PublicKey } = require('@solana/web3.js');
const { findReference, validateTransfer } = require('@solana/pay');
const BigNumber = require('bignumber.js');
const cron = require('node-cron');
const { pool } = require('../utils/database');
const { connection } = require('../utils/solana');
const config = require('../config');

// Payment Monitor class from original index.js
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
    console.log(`🔍 Started monitoring payment: ${reference}`);
  }

  stopMonitoring(reference) {
    this.activePayments.delete(reference);
    console.log(`⏹️ Stopped monitoring payment: ${reference}`);
  }

  getCheckInterval(paymentAgeSeconds) {
    if (paymentAgeSeconds < config.payment.initialDelaySeconds) return null;
    if (paymentAgeSeconds < 120) return 30; // 30s intervals for first 2 minutes
    if (paymentAgeSeconds < 240) return 15; // 15s intervals for next 2 minutes
    return config.payment.checkIntervalSeconds; // Default interval for final period
  }

  getActivePaymentsCount() {
    return this.activePayments.size;
  }
}

const paymentMonitor = new PaymentMonitor();

// Webhook sender from original index.js
async function sendWebhook(eventType, payload, paymentId = null, transactionId = null) {
  if (!config.webhooks.enabled) return;
  
  const dbConn = await pool.getConnection();
  try {
    // Store webhook event
    await dbConn.query(`
      INSERT INTO webhooks (event_type, payment_id, transaction_id, payload)
      VALUES (?, ?, ?, ?)
    `, [eventType, paymentId, transactionId, JSON.stringify(payload)]);
    
    console.log(`📤 Webhook stored: ${eventType}`);
  } catch (error) {
    console.error('Failed to store webhook event:', error.message);
  } finally {
    dbConn.release();
  }
}

// Update payment as completed from original index.js
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

// Batch check multiple payments from original index.js
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

// Clean up expired payments from original index.js
async function cleanupExpiredPayments(dbConn) {
  const [expiredPayments] = await dbConn.query(`
    SELECT reference FROM payments
    WHERE status IN ('pending', 'submitted') AND expires_at <= NOW()
  `);

  if (expiredPayments.length > 0) {
    // Stop monitoring expired payments
    for (const payment of expiredPayments) {
      paymentMonitor.stopMonitoring(payment.reference);
    }

    // Update status in database
    await dbConn.query(`
      UPDATE payments
      SET status = 'expired', updated_at = NOW()
      WHERE status IN ('pending', 'submitted') AND expires_at <= NOW()
    `);

    if (config.logging.enablePaymentLogging) {
      console.log(`🧹 Cleaned up ${expiredPayments.length} expired payments`);
    }
  }
}

// Optimized payment detection from original index.js
async function optimizedPaymentDetection() {
  if (!config.monitoring.enablePaymentMonitoring || !config.monitoring.enablePollingMonitoring) {
    return;
  }

  const now = Date.now();
  const dbConn = await pool.getConnection();
  
  try {
    // Get pending payments from last timeout period
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
    await cleanupExpiredPayments(dbConn);
    
  } catch (error) {
    console.error('Payment detection error:', error.message);
  } finally {
    dbConn.release();
  }
}

// Start payment monitoring cron job - every 10 seconds
if (config.monitoring.enablePaymentMonitoring) {
  cron.schedule('*/10 * * * * *', optimizedPaymentDetection);
  console.log('🔄 Payment monitoring started - checking every 10 seconds');
}

module.exports = {
  paymentMonitor,
  updatePaymentAsCompleted,
  optimizedPaymentDetection,
  batchCheckPayments,
  cleanupExpiredPayments,
  sendWebhook
};

// Add to your existing monitorService.js

const notificationService = require('./notificationService');
const callbackService = require('./callbackService');

// Update the updatePaymentAsCompleted function
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
    const [txResult] = await dbConn.query(`
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

    // Create transaction object for callbacks
    const transaction = {
      signature,
      from_wallet: fromWallet,
      to_wallet: payment.recipient_wallet,
      fee_lamports: txInfo?.meta?.fee || null,
      block_time: txInfo?.blockTime ? new Date(txInfo.blockTime * 1000) : null
    };

    // Send notifications
    await notificationService.sendPaymentCompletionEmail(payment, transaction);
    await notificationService.sendBrowserNotification(payment, 'completed');
    
    // Send merchant callback
    await callbackService.sendMerchantCallback(payment, transaction, 'payment.completed');

    // Store redirect URL for frontend
    const redirectUrl = callbackService.generatePaymentRedirect(payment, 'success');
    await dbConn.query(`
      UPDATE payments 
      SET redirect_url = ? 
      WHERE id = ?
    `, [redirectUrl, payment.id]);

    console.log(`✅ Payment completed: ${payment.reference} (${signature})`);
    console.log(`📍 Redirect URL: ${redirectUrl}`);

  } catch (error) {
    await dbConn.rollback();
    console.error('Error updating completed payment:', error);
  } finally {
    dbConn.release();
  }
}
