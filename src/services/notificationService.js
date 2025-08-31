// ============================================
// Notification Service - Email & SMS Notifications
// ============================================

const nodemailer = require('nodemailer');
const config = require('../config');

class NotificationService {
  constructor() {
    // Initialize email transporter
    this.emailTransporter = this.createEmailTransporter();
  }

  createEmailTransporter() {
    if (!config.notifications?.email?.enabled) return null;
    
    return nodemailer.createTransporter({
      host: config.notifications.email.smtp_host,
      port: config.notifications.email.smtp_port,
      secure: config.notifications.email.smtp_secure,
      auth: {
        user: config.notifications.email.smtp_user,
        pass: config.notifications.email.smtp_pass
      }
    });
  }

  // Send payment completion email
  async sendPaymentCompletionEmail(payment, transaction) {
    if (!this.emailTransporter || !payment.customer_email) return;

    const emailHtml = this.generatePaymentReceiptHTML(payment, transaction);
    
    const mailOptions = {
      from: config.notifications.email.from_address,
      to: payment.customer_email,
      subject: `Payment Confirmation - ${payment.label || 'Solana Payment'}`,
      html: emailHtml,
      attachments: [{
        filename: `receipt-${payment.reference}.json`,
        content: JSON.stringify({
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.token_symbol || 'SOL',
          transaction_hash: transaction.signature,
          timestamp: payment.validated_at,
          status: 'completed'
        }, null, 2)
      }]
    };

    try {
      await this.emailTransporter.sendMail(mailOptions);
      console.log(`📧 Payment receipt sent to ${payment.customer_email}`);
    } catch (error) {
      console.error('Failed to send payment receipt email:', error);
    }
  }

  // Send payment failure notification
  async sendPaymentFailureEmail(payment, reason) {
    if (!this.emailTransporter || !payment.customer_email) return;

    const mailOptions = {
      from: config.notifications.email.from_address,
      to: payment.customer_email,
      subject: `Payment Failed - ${payment.label || 'Solana Payment'}`,
      html: this.generatePaymentFailureHTML(payment, reason)
    };

    try {
      await this.emailTransporter.sendMail(mailOptions);
      console.log(`📧 Payment failure notice sent to ${payment.customer_email}`);
    } catch (error) {
      console.error('Failed to send payment failure email:', error);
    }
  }

  generatePaymentReceiptHTML(payment, transaction) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payment Receipt</title>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .receipt { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; }
          .detail-row { display: flex; justify-content: space-between; margin: 10px 0; }
          .success-badge { background: #10B981; color: white; padding: 8px 16px; border-radius: 20px; display: inline-block; }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="header">
            <h1>🎉 Payment Successful!</h1>
            <p>Your Solana payment has been confirmed</p>
          </div>
          <div class="content">
            <div class="success-badge">✅ Completed</div>
            
            <h3>Payment Details</h3>
            <div class="detail-row">
              <strong>Amount:</strong>
              <span>${payment.amount} ${payment.token_symbol || 'SOL'}</span>
            </div>
            <div class="detail-row">
              <strong>Reference:</strong>
              <span>${payment.reference}</span>
            </div>
            <div class="detail-row">
              <strong>Transaction Hash:</strong>
              <span>${transaction.signature}</span>
            </div>
            <div class="detail-row">
              <strong>Confirmed At:</strong>
              <span>${new Date(payment.validated_at).toLocaleString()}</span>
            </div>
            <div class="detail-row">
              <strong>Blockchain:</strong>
              <span>Solana ${config.solana.network}</span>
            </div>
            
            <p style="margin-top: 30px;">
              <a href="https://solscan.io/tx/${transaction.signature}" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
                View on Blockchain Explorer
              </a>
            </p>
            
            <p style="margin-top: 20px; color: #666; font-size: 14px;">
              This is an automated confirmation. Please keep this receipt for your records.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  generatePaymentFailureHTML(payment, reason) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payment Failed</title>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .notice { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #EF4444; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; }
          .retry-button { background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="notice">
          <div class="header">
            <h1>❌ Payment Failed</h1>
            <p>We couldn't process your payment</p>
          </div>
          <div class="content">
            <h3>What happened?</h3>
            <p><strong>Reason:</strong> ${reason}</p>
            <p><strong>Reference:</strong> ${payment.reference}</p>
            <p><strong>Amount:</strong> ${payment.amount} ${payment.token_symbol || 'SOL'}</p>
            
            <p>Don't worry - no funds were deducted from your account.</p>
            
            <h4>Next Steps:</h4>
            <ul>
              <li>Check your wallet balance</li>
              <li>Ensure you have sufficient funds</li>
              <li>Try the payment again</li>
              <li>Contact support if the issue persists</li>
            </ul>
            
            <a href="${config.frontend_url}/index.html?retry=${payment.reference}" class="retry-button">
              Try Payment Again
            </a>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Browser notification for real-time updates
  async sendBrowserNotification(payment, status) {
    const notificationData = {
      title: `Payment ${status}`,
      message: `${payment.amount} ${payment.token_symbol || 'SOL'} - ${payment.label}`,
      reference: payment.reference,
      timestamp: new Date().toISOString()
    };

    // Store notification for frontend polling
    const { pool } = require('../utils/database');
    const dbConn = await pool.getConnection();
    
    try {
      await dbConn.query(`
        INSERT INTO notifications (payment_reference, type, title, message, data, created_at)
        VALUES (?, 'payment_status', ?, ?, ?, NOW())
      `, [
        payment.reference,
        notificationData.title,
        notificationData.message,
        JSON.stringify(notificationData)
      ]);
    } finally {
      dbConn.release();
    }
  }
}

module.exports = new NotificationService();
