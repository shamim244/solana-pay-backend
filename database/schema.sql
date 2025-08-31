-- ============================================
-- Solana Pay Backend - Complete Database Schema
-- ============================================

-- Set character set and collation
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- Drop existing tables if they exist (for clean installation)
DROP TABLE IF EXISTS `rate_limits`;
DROP TABLE IF EXISTS `analytics`;
DROP TABLE IF EXISTS `webhooks`;
DROP TABLE IF EXISTS `api_logs`;
DROP TABLE IF EXISTS `transactions`;
DROP TABLE IF EXISTS `payments`;
DROP TABLE IF EXISTS `payment_sessions`;
DROP TABLE IF EXISTS `tokens`;
DROP TABLE IF EXISTS `universal_api_key`;
DROP TABLE IF EXISTS `system_config`;

-- Universal API Key Management
CREATE TABLE `universal_api_key` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `api_key` VARCHAR(255) NOT NULL UNIQUE,
  `description` VARCHAR(500),
  `is_active` BOOLEAN DEFAULT TRUE,
  `rate_limit_per_minute` INT DEFAULT 100,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_api_key` (`api_key`),
  INDEX `idx_is_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SPL Token Information (SOL, USDC, USDT, Custom Tokens)
CREATE TABLE `tokens` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `mint_address` VARCHAR(255) NOT NULL UNIQUE,
  `symbol` VARCHAR(20),
  `name` VARCHAR(100),
  `decimals` INT NOT NULL,
  `logo_url` VARCHAR(500),
  `website_url` VARCHAR(500),
  `description` TEXT,
  `total_supply` VARCHAR(255),
  `is_active` BOOLEAN DEFAULT TRUE,
  `is_custom` BOOLEAN DEFAULT FALSE,
  `added_by_api_key_id` INT NULL,
  `metadata_cache` JSON,
  `metadata_updated_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`added_by_api_key_id`) REFERENCES `universal_api_key`(`id`),
  INDEX `idx_mint_address` (`mint_address`),
  INDEX `idx_symbol` (`symbol`),
  INDEX `idx_is_active` (`is_active`),
  INDEX `idx_is_custom` (`is_custom`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Client Session Management
CREATE TABLE `payment_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(255) UNIQUE NOT NULL,
  `client_ip` VARCHAR(45),
  `user_agent` VARCHAR(500),
  `metadata` JSON,
  `expires_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payment Requests (All Types: Transfer, Transaction, Wallet)
CREATE TABLE `payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `reference` VARCHAR(255) UNIQUE NOT NULL,
  `api_key_id` INT NOT NULL,
  `payment_type` ENUM('transfer', 'transaction', 'wallet_direct', 'multi_method') NOT NULL,
  `amount` DECIMAL(30, 9) NOT NULL,
  `spl_token_id` INT NULL,
  `recipient_wallet` VARCHAR(255) NOT NULL,
  `sender_wallet` VARCHAR(255) NULL,
  `label` VARCHAR(255),
  `message` VARCHAR(500),
  `memo` VARCHAR(255),
  `qr_code_url` VARCHAR(500),
  `qr_code_svg` LONGTEXT,
  `session_id` INT NULL,
  `custom_program_id` VARCHAR(255) NULL,
  `custom_instruction_data` TEXT NULL,
  `status` ENUM('pending', 'submitted', 'validated', 'failed', 'cancelled', 'expired') DEFAULT 'pending',
  `error_message` VARCHAR(1000),
  `expires_at` TIMESTAMP NULL,
  `validated_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`api_key_id`) REFERENCES `universal_api_key`(`id`),
  FOREIGN KEY (`spl_token_id`) REFERENCES `tokens`(`id`),
  FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`),
  INDEX `idx_reference` (`reference`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_expires_at` (`expires_at`),
  INDEX `idx_recipient_wallet` (`recipient_wallet`),
  INDEX `idx_payment_type` (`payment_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- On-Chain Transaction Records
CREATE TABLE `transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `payment_id` INT NOT NULL,
  `signature` VARCHAR(255) UNIQUE,
  `from_wallet` VARCHAR(255) NOT NULL,
  `to_wallet` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(30, 9) NOT NULL,
  `spl_token_id` INT NULL,
  `fee_lamports` BIGINT,
  `slot` BIGINT,
  `block_time` TIMESTAMP NULL,
  `confirmation_status` ENUM('processed', 'confirmed', 'finalized') DEFAULT 'processed',
  `status` ENUM('success', 'failed', 'pending') DEFAULT 'pending',
  `error_message` VARCHAR(1000),
  `raw_transaction` LONGTEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`spl_token_id`) REFERENCES `tokens`(`id`),
  INDEX `idx_signature` (`signature`),
  INDEX `idx_payment_id` (`payment_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_block_time` (`block_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API Request Logs (Audit & Analytics)
CREATE TABLE `api_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `api_key_id` INT,
  `endpoint` VARCHAR(255) NOT NULL,
  `http_method` VARCHAR(10) NOT NULL,
  `client_ip` VARCHAR(45),
  `user_agent` VARCHAR(500),
  `request_headers` JSON,
  `request_body` LONGTEXT,
  `response_body` LONGTEXT,
  `status_code` INT,
  `response_time_ms` INT,
  `error_message` VARCHAR(1000),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`api_key_id`) REFERENCES `universal_api_key`(`id`),
  INDEX `idx_api_key_id` (`api_key_id`),
  INDEX `idx_endpoint` (`endpoint`),
  INDEX `idx_status_code` (`status_code`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Webhook Events (Async Processing)
CREATE TABLE `webhooks` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_type` VARCHAR(255) NOT NULL,
  `payment_id` INT NULL,
  `transaction_id` INT NULL,
  `payload` LONGTEXT NOT NULL,
  `webhook_url` VARCHAR(500),
  `attempts` INT DEFAULT 0,
  `max_attempts` INT DEFAULT 3,
  `processed` BOOLEAN DEFAULT FALSE,
  `last_attempt_at` TIMESTAMP NULL,
  `error_message` VARCHAR(1000),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `processed_at` TIMESTAMP NULL,
  FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`),
  FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`),
  INDEX `idx_processed` (`processed`),
  INDEX `idx_event_type` (`event_type`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate Limiting Tracking
CREATE TABLE `rate_limits` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `api_key_id` INT NOT NULL,
  `endpoint` VARCHAR(255),
  `client_ip` VARCHAR(45),
  `request_count` INT DEFAULT 1,
  `window_start` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `reset_at` TIMESTAMP,
  FOREIGN KEY (`api_key_id`) REFERENCES `universal_api_key`(`id`),
  INDEX `idx_api_key_endpoint` (`api_key_id`, `endpoint`),
  INDEX `idx_reset_at` (`reset_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Analytics & Metrics (Daily Aggregated Data)
CREATE TABLE `analytics` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `date` DATE NOT NULL,
  `api_key_id` INT,
  `total_requests` INT DEFAULT 0,
  `successful_payments` INT DEFAULT 0,
  `failed_payments` INT DEFAULT 0,
  `total_volume_sol` DECIMAL(30, 9) DEFAULT 0,
  `total_volume_usd` DECIMAL(30, 2) DEFAULT 0,
  `unique_recipients` INT DEFAULT 0,
  `unique_senders` INT DEFAULT 0,
  `average_payment_amount` DECIMAL(30, 9) DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`api_key_id`) REFERENCES `universal_api_key`(`id`),
  UNIQUE KEY `unique_date_api` (`date`, `api_key_id`),
  INDEX `idx_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System Configuration
CREATE TABLE `system_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_key` VARCHAR(255) UNIQUE NOT NULL,
  `config_value` TEXT,
  `description` VARCHAR(500),
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_config_key` (`config_key`),
  INDEX `idx_is_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Initial Data Seeding
-- ============================================

-- Insert Universal API Key (Change this in production!)
INSERT INTO `universal_api_key` (`api_key`, `description`, `is_active`, `rate_limit_per_minute`) 
VALUES ('solana-pay-universal-key-change-in-production', 'Universal API key for all merchants', TRUE, 100);

-- Insert Common SPL Tokens
INSERT INTO `tokens` (`mint_address`, `symbol`, `name`, `decimals`, `logo_url`, `is_active`, `is_custom`) VALUES
('So11111111111111111111111111111111111111112', 'SOL', 'Solana', 9, 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png', TRUE, FALSE),
('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'USD Coin', 6, 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png', TRUE, FALSE),
('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 'Tether USD', 6, 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png', TRUE, FALSE);

-- Insert System Configuration
INSERT INTO `system_config` (`config_key`, `config_value`, `description`) VALUES
('solana_network', 'mainnet-beta', 'Active Solana network'),
('default_confirmation_level', 'confirmed', 'Default transaction confirmation level'),
('payment_expiry_minutes', '5', 'Default payment expiry time in minutes'),
('max_payment_amount', '1000000', 'Maximum payment amount allowed'),
('min_payment_amount', '0.000001', 'Minimum payment amount allowed'),
('enable_custom_tokens', 'true', 'Allow custom SPL tokens'),
('webhook_enabled', 'true', 'Enable webhook notifications'),
('rate_limit_enabled', 'true', 'Enable API rate limiting'),
('analytics_enabled', 'true', 'Enable analytics collection');

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Show created tables
SHOW TABLES;

-- ============================================
-- Database Setup Complete
-- ============================================
