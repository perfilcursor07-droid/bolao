require('dotenv').config();
const pool = require('../src/config/database');
const { translateTeamName } = require('../src/utils/teamNamesPt');

async function localizeTeams() {
  const [games] = await pool.query('SELECT id, title, home_team, away_team FROM games');
  let updated = 0;

  for (const game of games) {
    const home = translateTeamName(game.home_team);
    const away = translateTeamName(game.away_team);
    if (home === game.home_team && away === game.away_team) continue;

    let title = game.title || '';
    if (title.includes(game.home_team)) title = title.replace(game.home_team, home);
    if (title.includes(game.away_team)) title = title.replace(game.away_team, away);

    await pool.query(
      'UPDATE games SET home_team = ?, away_team = ?, title = ? WHERE id = ?',
      [home, away, title, game.id]
    );
    updated++;
  }

  console.log(`✅ ${updated} jogo(s) atualizado(s) para português.`);
  await pool.end();
}

localizeTeams().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
