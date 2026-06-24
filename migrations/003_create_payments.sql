CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  game_id INT NOT NULL,
  reference_id VARCHAR(100) NOT NULL UNIQUE,
  pagbank_order_id VARCHAR(100) NULL,
  amount_cents INT NOT NULL,
  status ENUM('pending', 'paid', 'cancelled', 'expired', 'declined') NOT NULL DEFAULT 'pending',
  qr_code_text TEXT NULL,
  prediction_data JSON NULL,
  qr_expires_at DATETIME NULL,
  paid_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE RESTRICT,
  INDEX idx_payments_status (status),
  INDEX idx_payments_pagbank (pagbank_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
