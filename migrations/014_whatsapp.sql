CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  phone VARCHAR(20) NOT NULL,
  message_type ENUM('payment_confirmed', 'bet_result', 'manual', 'test') NOT NULL,
  reference_key VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  status ENUM('pending', 'processing', 'sent', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(255) NULL,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_whatsapp_reference (reference_key),
  INDEX idx_whatsapp_status (status, created_at),
  CONSTRAINT fk_whatsapp_outbox_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('whatsapp_notifications_enabled', '0');
