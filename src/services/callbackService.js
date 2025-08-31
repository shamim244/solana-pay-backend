// ============================================
// Callback Service - Merchant Notifications
// ============================================

const axios = require('axios');
const crypto = require('crypto');
const { pool } = require('../utils/database');
const config = require('../config');

class CallbackService {
  // Send callback to merchant
  async sendMerchantCallback(payment, transaction, eventType = 'payment.completed') {
    const dbConn = await pool.getConnection();
    
    try {
      // Get merchant callback URL from payment session or settings
      const [merchants] = await dbConn.query(`
        SELECT callback_url, webhook_secret FROM merchants 
        WHERE api_key_id = ?
      `, [payment.api_key_id]);

      if (merchants.length === 0 || !merchants[0].callback_url) {
        console.log('No callback URL configured for payment:', payment.reference);
        return;
      }

      const merchant = merchants[0];
      const callbackData = this.prepareCallbackData(payment, transaction, eventType);
      
      // Generate signature for security
      const signature = this.generateSignature(callbackData, merchant.webhook_secret);
      
      // Send callback
      const response = await axios.post(merchant.callback_url, callbackData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Solana-Pay-Signature': signature,
          'X-Solana-Pay-Event': eventType,
          'User-Agent': 'Solana-Pay-Webhook/1.0'
        },
        timeout: 30000,
        maxRetries: 3
      });

      // Log successful callback
      await this.logCallback(payment.id, merchant.callback_url, eventType, 'success', response.status);
      console.log(`✅ Callback sent successfully to ${merchant.callback_url}`);

    } catch (error) {
      console.error(`❌ Callback failed for payment ${payment.reference}:`, error.message);
      await this.logCallback(payment.id, merchant?.callback_url, eventType, 'failed', 0, error.message);
      
      // Schedule retry
      await this.scheduleCallbackRetry(payment, transaction, eventType);
    } finally {
      dbConn.release();
    }
  }

  prepareCallbackData(payment, transaction, eventType) {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      payment: {
        reference: payment.reference,
        amount: parseFloat(payment.amount),
        currency: payment.token_symbol || 'SOL',
        status: payment.status,
        label: payment.label,
        message: payment.message,
        memo: payment.memo,
        created_at: payment.created_at,
        expires_at: payment.expires_at,
        validated_at: payment.validated_at
      },
      transaction: transaction ? {
        signature: transaction.signature,
        from_wallet: transaction.from_wallet,
        to_wallet: transaction.to_wallet,
        fee_lamports: transaction.fee_lamports,
        block_time: transaction.block_time,
        explorer_url: `https://solscan.io/tx/${transaction.signature}`
      } : null,
      merchant: {
        return_url: this.generateReturnUrl(payment, 'success'),
        cancel_url: this.generateReturnUrl(payment, 'cancelled')
      }
    };
  }

  generateSignature(data, secret) {
    if (!secret) return null;
    
    const payload = JSON.stringify(data);
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  generateReturnUrl(payment, status) {
    const baseUrl = config.frontend_url || 'http://localhost:8080';
    const returnUrl = payment.return_url || `${baseUrl}/${status}.html`;
    
    const url = new URL(returnUrl);
    url.searchParams.set('ref', payment.reference);
    url.searchParams.set('status', status);
    
    return url.toString();
  }

  async logCallback(paymentId, url, eventType, status, httpCode, error = null) {
    const { pool } = require('../utils/database');
    const dbConn = await pool.getConnection();
    
    try {
      await dbConn.query(`
        INSERT INTO callback_logs (payment_id, callback_url, event_type, status, http_code, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, [paymentId, url, eventType, status, httpCode, error]);
    } finally {
      dbConn.release();
    }
  }

  async scheduleCallbackRetry(payment, transaction, eventType) {
    // Implement exponential backoff retry logic
    const retryDelays = [30, 120, 300, 900]; // 30s, 2m, 5m, 15m
    
    for (let i = 0; i < retryDelays.length; i++) {
      setTimeout(async () => {
        console.log(`⏰ Retrying callback for payment ${payment.reference} (attempt ${i + 2})`);
        await this.sendMerchantCallback(payment, transaction, eventType);
      }, retryDelays[i] * 1000);
    }
  }

  // Send immediate redirect response
  generatePaymentRedirect(payment, status = 'success') {
    const baseUrl = config.frontend_url || 'http://localhost:8080';
    const redirectUrl = new URL(`${baseUrl}/${status}.html`);
    
    redirectUrl.searchParams.set('ref', payment.reference);
    redirectUrl.searchParams.set('amount', payment.amount);
    redirectUrl.searchParams.set('currency', payment.token_symbol || 'SOL');
    
    if (payment.return_url) {
      redirectUrl.searchParams.set('return_url', payment.return_url);
    }
    
    if (payment.merchant_name) {
      redirectUrl.searchParams.set('merchant', payment.merchant_name);
    }
    
    return redirectUrl.toString();
  }
}

module.exports = new CallbackService();
