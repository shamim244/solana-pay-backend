// ============================================
// Wallet Service - Direct Wallet Payment Logic
// ============================================

const { 
  PublicKey, 
  Keypair, 
  Transaction, 
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL 
} = require('@solana/web3.js');
const {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint
} = require('@solana/spl-token');
const BigNumber = require('bignumber.js');
const { pool } = require('../utils/database');
const { connection } = require('../utils/solana');
const config = require('../config');

// Helper function to get token ID
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

class WalletService {

  // Migrated from index.js - Create transaction for wallet payment
  async createWalletTransaction(data, apiKeyId) {
    const {
      recipient,
      amount,
      token_mint_address,
      label,
      message,
      memo,
      payer_wallet,
      sessionId
    } = data;

    // Validation
    if (!payer_wallet) {
      throw new Error('Payer wallet address required');
    }

    if (!recipient || !amount) {
      throw new Error('Missing required fields: recipient and amount');
    }

    // Validate addresses
    try {
      new PublicKey(payer_wallet);
      new PublicKey(recipient);
    } catch (error) {
      throw new Error('Invalid wallet address format');
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
            apiKeyId
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
        apiKeyId,
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

      return {
        payment_id: result.insertId,
        reference: refKey.toBase58(),
        transaction: serializedTransaction,
        expires_at: expiresAt.toISOString(),
        message: message || `Pay ${amount} ${token_mint_address ? 'tokens' : 'SOL'} to ${label || 'merchant'}`
      };

    } finally {
      dbConn.release();
    }
  }

  // Migrated from index.js - Submit signed transaction
  async submitSignedTransaction(data) {
    const { reference, signed_transaction } = data;

    if (!reference || !signed_transaction) {
      throw new Error('Missing required fields: reference and signed_transaction');
    }

    const dbConn = await pool.getConnection();
    
    try {
      // Get payment details
      const [payments] = await dbConn.query(
        'SELECT * FROM payments WHERE reference = ? AND payment_type = "wallet_direct"',
        [reference]
      );

      if (payments.length === 0) {
        return null;
      }

      const payment = payments[0];
      if (payment.status !== 'pending') {
        throw new Error(`Payment already processed. Current status: ${payment.status}`);
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
      const { paymentMonitor } = require('./monitorService');
      paymentMonitor.startMonitoring(reference, {
        id: payment.id,
        amount: payment.amount,
        recipient_wallet: payment.recipient_wallet,
        signature: signature
      });

      return {
        signature: signature,
        explorer_url: `https://solscan.io/tx/${signature}`,
        status: 'submitted',
        message: 'Transaction submitted successfully. Waiting for confirmation...'
      };

    } finally {
      dbConn.release();
    }
  }
}

module.exports = new WalletService();
