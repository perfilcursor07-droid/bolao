-- Tabela de pagamentos de prêmios aos ganhadores
CREATE TABLE IF NOT EXISTS payouts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bet_id INT NOT NULL,
  user_id INT NOT NULL,
  game_id INT NOT NULL,
  amount_cents INT NOT NULL,
  status ENUM('pending', 'paid') NOT NULL DEFAULT 'pending',
  paid_at DATETIME NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bet_id) REFERENCES bets(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE RESTRICT,
  INDEX idx_payouts_status (status),
  INDEX idx_payouts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
