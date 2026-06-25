const pool = require('../config/database');

async function getPendingPaymentsForUser(userId) {
  const [rows] = await pool.query(
    `SELECT p.id, p.amount_cents, p.created_at, g.title, g.home_team, g.away_team
     FROM payments p
     JOIN games g ON g.id = p.game_id
     WHERE p.user_id = ?
       AND p.status = 'pending'
       AND p.qr_code_text IS NOT NULL
       AND p.qr_code_text != ''
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

async function getPendingPaymentsCount(userId) {
  const rows = await getPendingPaymentsForUser(userId);
  return rows.length;
}

module.exports = { getPendingPaymentsForUser, getPendingPaymentsCount };
