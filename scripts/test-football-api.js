#!/usr/bin/env node
/**
 * Testa a API de futebol (rodar no servidor após configurar .env).
 * Uso: node scripts/test-football-api.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getWorldCupMatches } = require('../src/services/footballApi');

(async () => {
  console.log('--- Teste API Copa ---');
  const { matches, error } = await getWorldCupMatches();
  if (error) {
    console.error('❌', error);
    process.exit(1);
  }
  console.log(`✅ ${matches.length} partidas encontradas`);
  if (matches[0]) {
    console.log('Exemplo:', matches[0].homeTeam, 'x', matches[0].awayTeam);
  }
  process.exit(0);
})();
