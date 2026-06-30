#!/usr/bin/env node
/**
 * Verifica se o .env está correto (rodar no servidor).
 * Uso: node scripts/check-env.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pixEnv = process.env.PIX_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
const token = (process.env.PAGBANK_TOKEN || '').trim();
const port = process.env.PORT || '(não definido)';

console.log('--- Verificação .env ---');
console.log('PORT:', port);
console.log('PIX_ENVIRONMENT:', pixEnv, process.env.PIX_ENVIRONMENT === 'production' ? '✅' : '⚠️  use production com token real');
console.log('PAGBANK_TOKEN:', token ? `${token.length} caracteres` : '❌ VAZIO');
console.log('PAGBANK_EMAIL:', process.env.PAGBANK_EMAIL || '(não definido)');
console.log('APP_URL:', process.env.APP_URL || '(não definido)');
console.log('WEBHOOK_URL:', process.env.WEBHOOK_URL || '(não definido)');

const fdKey = (process.env.FOOTBALL_API_KEY || '').trim();
const asKey = (process.env.APISPORTS_KEY || '').trim();
const wc26 = String(process.env.WORLDCUP26_API ?? '1').toLowerCase();
console.log('WORLDCUP26_API:', ['0', 'false', 'no'].includes(wc26) ? 'desligada' : 'ativa (worldcup26.ir)');
console.log('FOOTBALL_API_KEY:', fdKey ? `${fdKey.length} caracteres (fallback)` : '(vazio — opcional)');
console.log('APISPORTS_KEY:', asKey ? `${asKey.length} caracteres (fallback)` : '(vazio — opcional)');

if (pixEnv === 'sandbox' && token.length > 80) {
  console.log('\n⚠️  Token longo + sandbox: provavelmente token de PRODUÇÃO.');
  console.log('   Altere: PIX_ENVIRONMENT=production');
}
