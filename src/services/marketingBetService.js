const pool = require('../config/database');

const FIRST_NAMES = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João',
  'Karina', 'Lucas', 'Mariana', 'Nicolas', 'Olivia', 'Paulo', 'Raquel', 'Samuel', 'Tatiana', 'Vitor',
  'Amanda', 'Bernardo', 'Camila', 'Daniel', 'Fernanda', 'Gustavo', 'Helena', 'Igor', 'Juliana', 'Leonardo',
];

const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Ferreira', 'Rodrigues', 'Almeida',
  'Nascimento', 'Carvalho', 'Araújo', 'Ribeiro', 'Martins', 'Gomes', 'Barbosa', 'Rocha', 'Dias', 'Castro',
  'Mendes', 'Freitas', 'Cardoso', 'Teixeira', 'Correia', 'Monteiro', 'Moura', 'Cavalcanti', 'Ramos', 'Pinto',
];

function firstName(name) {
  if (!name || !String(name).trim()) return 'Participante';
  return String(name).trim().split(/\s+/)[0];
}

function randomDisplayName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

function randomScore() {
  const presets = [
    [1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [0, 0], [1, 1], [0, 1], [0, 2], [1, 2],
  ];
  const [home, away] = presets[Math.floor(Math.random() * presets.length)];
  return { home, away };
}

function gameBetCountSubquery(gameAlias = 'g') {
  return `(SELECT COUNT(*) FROM bets b WHERE b.game_id = ${gameAlias}.id)
    + (SELECT COUNT(*) FROM marketing_bets mb WHERE mb.game_id = ${gameAlias}.id)`;
}

function marketingPoolSubquery(gameAlias = 'g') {
  return `(SELECT COALESCE(SUM(mb.amount_cents), 0) FROM marketing_bets mb WHERE mb.game_id = ${gameAlias}.id)`;
}

function enrichGameForDisplay(game) {
  if (!game) return game;
  const realPool = parseInt(game.prize_pool_cents, 10) || 0;
  const marketingPool = parseInt(game.marketing_pool_cents, 10) || 0;
  return {
    ...game,
    marketing_pool_cents: marketingPool,
    display_prize_pool_cents: realPool + marketingPool,
  };
}

function enrichGamesForDisplay(games) {
  return (games || []).map(enrichGameForDisplay);
}

async function attachMarketingPoolToGame(game) {
  if (!game?.id) return game;
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS marketing_pool_cents FROM marketing_bets WHERE game_id = ?`,
    [game.id]
  );
  return enrichGameForDisplay({ ...game, marketing_pool_cents: rows[0].marketing_pool_cents });
}

async function createMarketingBet({ gameId, displayName, home, away, amountCents }) {
  const name = String(displayName || '').trim();
  if (!name || name.length < 2) {
    return { error: 'Informe um nome válido' };
  }
  if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away > 20 || away < 0 || home > 20) {
    return { error: 'Placar inválido' };
  }
  if (!Number.isFinite(amountCents) || amountCents < 100) {
    return { error: 'Valor inválido' };
  }

  const [games] = await pool.query('SELECT id, entry_fee_cents, status FROM games WHERE id = ?', [gameId]);
  if (games.length === 0) return { error: 'Jogo não encontrado' };
  if (games[0].status === 'finished') return { error: 'Jogo já finalizado' };

  const [result] = await pool.query(
    `INSERT INTO marketing_bets (game_id, display_name, home_score_prediction, away_score_prediction, amount_cents)
     VALUES (?, ?, ?, ?, ?)`,
    [gameId, name.slice(0, 120), home, away, Math.round(amountCents)]
  );

  return { id: result.insertId };
}

const MAX_BULK_QUANTITY = 50;

async function createMarketingBetsBulk({ gameId, quantity, amountCents }) {
  const qty = Math.min(MAX_BULK_QUANTITY, Math.max(1, parseInt(quantity, 10) || 1));

  const [games] = await pool.query('SELECT id, entry_fee_cents, status FROM games WHERE id = ?', [gameId]);
  if (games.length === 0) return { error: 'Jogo não encontrado' };
  if (games[0].status === 'finished') return { error: 'Jogo já finalizado' };

  const amount = Number.isFinite(amountCents) && amountCents >= 100
    ? Math.round(amountCents)
    : games[0].entry_fee_cents;
  if (!amount || amount < 100) return { error: 'Valor inválido' };

  const usedNames = new Set();
  const rows = [];

  for (let i = 0; i < qty; i++) {
    let name = randomDisplayName();
    for (let attempt = 0; attempt < 30 && usedNames.has(name); attempt++) {
      name = randomDisplayName();
    }
    usedNames.add(name);
    const score = randomScore();
    rows.push([gameId, name.slice(0, 120), score.home, score.away, amount]);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const row of rows) {
      await connection.query(
        `INSERT INTO marketing_bets (game_id, display_name, home_score_prediction, away_score_prediction, amount_cents)
         VALUES (?, ?, ?, ?, ?)`,
        row
      );
    }
    await connection.commit();
    return { count: qty };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function deleteMarketingBet(id) {
  const [result] = await pool.query('DELETE FROM marketing_bets WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function updateMarketingBet(id, { displayName, home, away, amountCents }) {
  const name = String(displayName || '').trim();
  if (!name || name.length < 2) return { error: 'Informe um nome válido' };
  if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away > 20 || away < 0 || home > 20) {
    return { error: 'Placar inválido' };
  }
  if (!Number.isFinite(amountCents) || amountCents < 100) return { error: 'Valor inválido' };

  const [rows] = await pool.query(
    `SELECT mb.*, g.status as game_status
     FROM marketing_bets mb JOIN games g ON g.id = mb.game_id WHERE mb.id = ?`,
    [id]
  );
  if (rows.length === 0) return { error: 'Aposta marketing não encontrada' };
  if (rows[0].game_status === 'finished') return { error: 'Jogo já finalizado' };

  await pool.query(
    `UPDATE marketing_bets SET display_name = ?, home_score_prediction = ?, away_score_prediction = ?, amount_cents = ?
     WHERE id = ?`,
    [name.slice(0, 120), home, away, Math.round(amountCents), id]
  );

  return { ok: true };
}

async function listMarketingBetsForAdmin({ gameId } = {}) {
  let sql = `SELECT mb.*, g.title as game_title, g.home_team, g.away_team, g.status as game_status, g.game_date
    FROM marketing_bets mb JOIN games g ON g.id = mb.game_id`;
  const params = [];
  if (gameId) {
    sql += ' WHERE mb.game_id = ?';
    params.push(gameId);
  }
  sql += ' ORDER BY mb.created_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

function mapMarketingBetForPublic(row) {
  return {
    game_id: row.game_id,
    home_score_prediction: row.home_score_prediction,
    away_score_prediction: row.away_score_prediction,
    is_winner: false,
    prize_amount_cents: 0,
    name: firstName(row.display_name),
    is_marketing: true,
    created_at: row.created_at,
  };
}

function mapMarketingBetForAdmin(row) {
  return {
    id: row.id,
    marketing_id: row.id,
    is_marketing: true,
    user_name: row.display_name,
    phone: null,
    cpf: null,
    user_role: null,
    home_score_prediction: row.home_score_prediction,
    away_score_prediction: row.away_score_prediction,
    payment_status: 'paid',
    amount_cents: row.amount_cents,
    paid_at: null,
    is_winner: false,
    prize_amount_cents: 0,
    prize_paid_at: null,
    game_id: row.game_id,
    game_title: row.game_title,
    home_team: row.home_team,
    away_team: row.away_team,
    home_score: null,
    away_score: null,
    game_status: row.game_status,
    game_date: row.game_date,
    created_at: row.created_at,
  };
}

async function loadMarketingBetsForGames(gameIds) {
  if (!gameIds.length) return {};
  const [rows] = await pool.query(
    `SELECT mb.* FROM marketing_bets mb
     WHERE mb.game_id IN (?)
     ORDER BY mb.game_id, mb.created_at ASC`,
    [gameIds]
  );
  const byGame = {};
  for (const row of rows) {
    if (!byGame[row.game_id]) byGame[row.game_id] = [];
    byGame[row.game_id].push(mapMarketingBetForPublic(row));
  }
  return byGame;
}

module.exports = {
  randomDisplayName,
  randomScore,
  gameBetCountSubquery,
  marketingPoolSubquery,
  enrichGameForDisplay,
  enrichGamesForDisplay,
  attachMarketingPoolToGame,
  createMarketingBet,
  createMarketingBetsBulk,
  MAX_BULK_QUANTITY,
  deleteMarketingBet,
  updateMarketingBet,
  listMarketingBetsForAdmin,
  mapMarketingBetForAdmin,
  loadMarketingBetsForGames,
};
