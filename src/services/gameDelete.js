const pool = require('../config/database');

async function deleteByGameIds(conn, table, placeholders, ids) {
  try {
    await conn.query(`DELETE FROM ${table} WHERE game_id IN (${placeholders})`, ids);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
}

async function deleteGamesByIds(ids) {
  if (!ids.length) return 0;

  const conn = await pool.getConnection();
  const placeholders = ids.map(() => '?').join(',');

  try {
    await conn.beginTransaction();
    await deleteByGameIds(conn, 'marketing_bets', placeholders, ids);
    await deleteByGameIds(conn, 'payouts', placeholders, ids);
    await deleteByGameIds(conn, 'bets', placeholders, ids);
    await deleteByGameIds(conn, 'payments', placeholders, ids);
    const [result] = await conn.query(`DELETE FROM games WHERE id IN (${placeholders})`, ids);
    await conn.commit();
    return result.affectedRows;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { deleteGamesByIds };
