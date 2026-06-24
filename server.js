const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const app = require('./src/app');
const { startCronJobs } = require('./src/services/cronJobs');

const PORT = process.env.PORT || 3000;

const pixEnv = process.env.PIX_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
const tokenLen = (process.env.PAGBANK_TOKEN || '').trim().length;

const server = app.listen(PORT, () => {
  console.log(`\n⚽ Bolão Online rodando em http://localhost:${PORT}`);
  console.log(`   Admin: admin@bolao.com / admin123`);
  console.log(`   PagBank: ${pixEnv}${tokenLen ? ` (token ${tokenLen} chars)` : ' ⚠️ PAGBANK_TOKEN vazio'}\n`);
  startCronJobs();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORT} já está em uso.`);
    console.error('   Feche o servidor anterior (Ctrl+C) ou execute:');
    console.error(`   netstat -ano | findstr :${PORT}`);
    console.error('   taskkill /PID <numero> /F\n');
    process.exit(1);
  }
  throw err;
});
