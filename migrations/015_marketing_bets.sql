CREATE TABLE IF NOT EXISTS marketing_bets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  game_id INT NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  home_score_prediction INT NOT NULL,
  away_score_prediction INT NOT NULL,
  amount_cents INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  INDEX idx_marketing_bets_game (game_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
