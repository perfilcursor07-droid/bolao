require('dotenv').config();
const { findDuplicateGroups, removeSafeDuplicateGames } = require('../src/services/gameDuplicateService');

(async () => {
  const groups = await findDuplicateGroups();
  console.log(`Grupos duplicados: ${groups.length}`);

  for (const group of groups) {
    const ids = group.map((g) => g.id).join(', ');
    const bets = group.map((g) => g.bet_count).join('/');
    console.log(`  [${ids}] apostas: ${bets} — ${group[0].home_team} x ${group[0].away_team}`);
  }

  const { deleted, skippedGroups } = await removeSafeDuplicateGames();
  console.log(`\n✅ Removidas: ${deleted} | Grupos restantes: ${skippedGroups}`);

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
