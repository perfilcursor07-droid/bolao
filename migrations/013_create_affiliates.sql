CREATE TABLE IF NOT EXISTS affiliates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  code VARCHAR(32) NOT NULL UNIQUE,
  status ENUM('pending', 'active', 'rejected', 'suspended') NOT NULL DEFAULT 'pending',
  balance_cents INT NOT NULL DEFAULT 0,
  total_earned_cents INT NOT NULL DEFAULT 0,
  total_paid_referrals INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_affiliates_code (code),
  INDEX idx_affiliates_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  affiliate_id INT NOT NULL,
  referred_user_id INT NOT NULL UNIQUE,
  first_paid_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE RESTRICT,
  FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_aff_ref_affiliate (affiliate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  affiliate_id INT NOT NULL,
  referred_user_id INT NULL,
  payment_id INT NULL,
  type ENUM('first_bet', 'milestone') NOT NULL,
  milestone_count INT NULL,
  amount_cents INT NOT NULL,
  status ENUM('available', 'paid', 'cancelled') NOT NULL DEFAULT 'available',
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL,
  FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE RESTRICT,
  FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  UNIQUE KEY uq_aff_first_payment (affiliate_id, payment_id, type),
  INDEX idx_aff_comm_affiliate (affiliate_id),
  INDEX idx_aff_comm_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS affiliate_milestone_claims (
  id INT AUTO_INCREMENT PRIMARY KEY,
  affiliate_id INT NOT NULL,
  milestone_count INT NOT NULL,
  amount_cents INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_aff_milestone (affiliate_id, milestone_count),
  FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
