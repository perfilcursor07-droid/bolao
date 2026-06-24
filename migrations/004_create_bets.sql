CREATE TABLE IF NOT EXISTS bets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  game_id INT NOT NULL,
  payment_id INT NOT NULL,
  home_score_prediction INT NOT NULL,
  away_score_prediction INT NOT NULL,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  prize_amount_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  UNIQUE KEY unique_user_game (user_id, game_id),
  INDEX idx_bets_game (game_id),
  INDEX idx_bets_winner (is_winner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
