require('dotenv').config();
const app = require('./src/app');
const { startCronJobs } = require('./src/services/cronJobs');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`\n⚽ Bolão Online rodando em http://localhost:${PORT}`);
  console.log(`   Admin: admin@bolao.com / admin123\n`);
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
