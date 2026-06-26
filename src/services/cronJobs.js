const cron = require('node-cron');
const pool = require('../config/database');
const { getOrderStatus, extractChargeStatus } = require('./pagbank');
const { confirmPayment } = require('./prizeService');
const { closeExpiredOpenGames, finalizeClosedGamesWithScores, syncGamesFromWorldCupMatches, syncGamesFromApi } = require('./gameStatusService');

function startCronJobs() {
  cron.schedule('*/1 * * * *', async () => {
    try {
      await closeExpiredOpenGames();
      const finalized = await finalizeClosedGamesWithScores();
      if (finalized > 0) {
        console.log(`[cron] ${finalized} jogo(s) finalizado(s) com placar`);
      }
    } catch (err) {
      console.error('[cron] Erro ao fechar/finalizar jogos:', err.message);
    }
  });

  cron.schedule('*/2 * * * *', async () => {
    await checkPendingPayments();
  });

  // 1 chamada à API atualiza todos os bolões + cache da Copa (a cada 3 min)
  cron.schedule('*/3 * * * *', async () => {
    try {
      const synced = await syncGamesFromWorldCupMatches();
      if (synced > 0) {
        console.log(`[cron] ${synced} bolão(ões) sincronizado(s) via Copa API`);
      }
    } catch (err) {
      console.error('[cron] Erro sync Copa API:', err.message);
    }
  });

  // Fallback: jogos sem api_match_id ou fora da lista WC
  cron.schedule('*/10 * * * *', async () => {
    try {
      const synced = await syncGamesFromApi({ maxGames: 2 });
      if (synced > 0) {
        console.log(`[cron] ${synced} jogo(s) sincronizado(s) via match API`);
      }
    } catch (err) {
      console.error('[cron] Erro sync match API:', err.message);
    }
  });

  console.log('⏰ Cron jobs iniciados (fechar: 1min, pagamentos: 2min, Copa API: 3min, match API: 10min)');
}

async function checkPendingPayments() {
  try {
    const [payments] = await pool.query(
      `SELECT * FROM payments
       WHERE status = 'pending'
         AND pagbank_order_id IS NOT NULL
         AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );

    for (const payment of payments) {
      try {
        const order = await getOrderStatus(payment.pagbank_order_id);
        const status = extractChargeStatus(order);

        if (status === 'PAID') {
          await confirmPayment(payment.id);
          console.log(`✅ Pagamento confirmado: ${payment.reference_id}`);
        } else if (['CANCELED', 'DECLINED'].includes(status)) {
          await pool.query('UPDATE payments SET status = ? WHERE id = ?', [
            status === 'CANCELED' ? 'cancelled' : 'declined',
            payment.id,
          ]);
        }
      } catch (err) {
        console.error(`Erro ao verificar pagamento ${payment.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Erro no cron de pagamentos:', err.message);
  }
}

module.exports = { startCronJobs };
