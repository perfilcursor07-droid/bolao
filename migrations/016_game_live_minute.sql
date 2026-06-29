ALTER TABLE games
  ADD COLUMN api_match_status VARCHAR(20) NULL AFTER away_score,
  ADD COLUMN match_minute INT NULL AFTER api_match_status,
  ADD COLUMN match_injury_time INT NULL AFTER match_minute;
