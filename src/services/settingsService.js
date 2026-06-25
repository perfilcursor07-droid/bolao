const pool = require('../config/database');

const DEFAULT_ENTRY_FEE_CENTS = 1000;

async function getDefaultEntryFeeCents() {
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'default_entry_fee_cents' LIMIT 1"
    );
    if (rows.length === 0) return DEFAULT_ENTRY_FEE_CENTS;
    const cents = parseInt(rows[0].setting_value, 10);
    return Number.isFinite(cents) && cents > 0 ? cents : DEFAULT_ENTRY_FEE_CENTS;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return DEFAULT_ENTRY_FEE_CENTS;
    throw err;
  }
}

function centsToReaisInput(cents) {
  return (cents / 100).toFixed(2);
}

async function getDefaultEntryFeeReais() {
  return centsToReaisInput(await getDefaultEntryFeeCents());
}

async function setDefaultEntryFeeFromReais(reais, options = {}) {
  const cents = Math.round(parseFloat(reais) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error('Informe um valor maior que zero');
  }

  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES ('default_entry_fee_cents', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [String(cents)]
  );

  let openGamesUpdated = 0;
  if (options.applyToOpenGames !== false) {
    openGamesUpdated = await applyEntryFeeToOpenGames(cents);
  }

  return { cents, openGamesUpdated };
}

async function applyEntryFeeToOpenGames(cents) {
  const [result] = await pool.query(
    `UPDATE games SET entry_fee_cents = ? WHERE status = 'open'`,
    [cents]
  );
  return result.affectedRows || 0;
}

module.exports = {
  DEFAULT_ENTRY_FEE_CENTS,
  getDefaultEntryFeeCents,
  getDefaultEntryFeeReais,
  setDefaultEntryFeeFromReais,
  applyEntryFeeToOpenGames,
  centsToReaisInput,
};
