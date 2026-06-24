ALTER TABLE games ADD COLUMN featured TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
CREATE INDEX idx_games_featured ON games(featured);
