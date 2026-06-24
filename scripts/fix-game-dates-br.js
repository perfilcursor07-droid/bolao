require('dotenv').config();
const pool = require('../src/config/database');

/**
 * Ajusta jogos importados em UTC para horário de Brasília (-3h).
 * Rode UMA vez se os horários estiverem 3h adiantados.
 */
async function fixGameDatesBR() {
  const [before] = await pool.query('SELECT id, home_team, away_team, game_date FROM games LIMIT 3');
  console.log('Exemplo antes:', before);

  const [result] = await pool.query(
    'UPDATE games SET game_date = DATE_SUB(game_date, INTERVAL 3 HOUR)'
  );

  const [after] = await pool.query('SELECT id, home_team, away_team, game_date FROM games LIMIT 3');
  console.log('Exemplo depois:', after);
  console.log(`✅ ${result.affectedRows} jogo(s) ajustado(s) para horário de Brasília.`);
  await pool.end();
}

fixGameDatesBR().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
