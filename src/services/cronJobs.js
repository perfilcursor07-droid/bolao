const cron = require('node-cron');
const pool = require('../config/database');
const { getOrderStatus, extractChargeStatus } = require('./pagbank');
const { confirmPayment } = require('./prizeService');
const { closeExpiredOpenGames, finalizeClosedGamesWithScores, syncGamesFromWorldCupMatches, syncGamesFromApi, syncLiveGameScores } = require('./gameStatusService');
const { expirePendingPaymentsForClosedBetting } = require('./paymentGateService');

function startCronJobs() {
  cron.schedule('*/1 * * * *', async () => {
    try {
      await closeExpiredOpenGames();
      const expiredPix = await expirePendingPaymentsForClosedBetting();
      if (expiredPix > 0) {
        console.log(`[cron] ${expiredPix} PIX pendente(s) expirado(s) — apostas encerradas`);
      }
      const finalized = await finalizeClosedGamesWithScores();
      if (finalized > 0) {
        console.log(`[cron] ${finalized} jogo(s) finalizado(s) com placar`);
      }
      const liveSynced = await syncLiveGameScores({ forceRefresh: true });
      if (liveSynced > 0) {
        console.log(`[cron] ${liveSynced} placar(es) ao vivo atualizado(s)`);
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

  console.log('⏰ Cron jobs iniciados (fechar+live: 1min, pagamentos: 2min, Copa API: 3min, match API: 10min)');
}

async function checkPendingPayments() {
  try {
    const [payments] = await pool.query(
      `SELECT p.*, g.status AS game_status, g.game_date
       FROM payments p
       JOIN games g ON g.id = p.game_id
       WHERE p.status = 'pending'
         AND p.pagbank_order_id IS NOT NULL
         AND p.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );

    for (const payment of payments) {
      try {
        const order = await getOrderStatus(payment.pagbank_order_id);
        const status = extractChargeStatus(order);

        if (status === 'PAID') {
          const result = await confirmPayment(payment.id);
          if (result?.rejected) {
            console.warn(`⚠️ PIX recusado (apostas encerradas): ${payment.reference_id}`);
          } else {
            console.log(`✅ Pagamento confirmado: ${payment.reference_id}`);
          }
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
