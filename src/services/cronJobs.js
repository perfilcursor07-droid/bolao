const cron = require('node-cron');
const pool = require('../config/database');
const { getMatchResult } = require('./footballApi');
const { processGameResults } = require('./prizeService');
const { getOrderStatus, extractChargeStatus } = require('./pagbank');
const { confirmPayment } = require('./prizeService');

function startCronJobs() {
  cron.schedule('*/2 * * * *', async () => {
    await checkPendingPayments();
  });

  cron.schedule('*/5 * * * *', async () => {
    await fetchGameResults();
  });

  console.log('⏰ Cron jobs iniciados (pagamentos: 2min, resultados: 5min)');
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

async function fetchGameResults() {
  try {
    const [games] = await pool.query(
      `SELECT * FROM games
       WHERE status IN ('open', 'closed')
         AND api_match_id IS NOT NULL
         AND game_date < NOW()`
    );

    for (const game of games) {
      try {
        const result = await getMatchResult(game.api_match_id);
        if (!result || !result.finished) continue;

        await pool.query(
          'UPDATE games SET home_score = ?, away_score = ?, status = ? WHERE id = ?',
          [result.homeScore, result.awayScore, 'closed', game.id]
        );

        const prizeResult = await processGameResults(game.id);
        console.log(
          `🏆 Jogo ${game.id} finalizado. Ganhadores: ${prizeResult?.winners || 0}`
        );
      } catch (err) {
        console.error(`Erro ao processar jogo ${game.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Erro no cron de resultados:', err.message);
  }
}

module.exports = { startCronJobs };
