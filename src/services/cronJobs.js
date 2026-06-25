const cron = require('node-cron');
const pool = require('../config/database');
const { getOrderStatus, extractChargeStatus } = require('./pagbank');
const { confirmPayment } = require('./prizeService');
const { closeExpiredOpenGames, syncGamesFromApi } = require('./gameStatusService');

function startCronJobs() {
  cron.schedule('*/1 * * * *', async () => {
    try {
      await closeExpiredOpenGames();
    } catch (err) {
      console.error('[cron] Erro ao fechar jogos expirados:', err.message);
    }
  });

  cron.schedule('*/2 * * * *', async () => {
    await checkPendingPayments();
  });

  cron.schedule('*/10 * * * *', async () => {
    try {
      const synced = await syncGamesFromApi({ nearOnly: true, maxGames: 4 });
      if (synced > 0) {
        console.log(`[cron] ${synced} jogo(s) sincronizado(s) via API`);
      }
    } catch (err) {
      console.error('[cron] Erro ao sincronizar jogos ao vivo:', err.message);
    }
  });

  console.log('⏰ Cron jobs iniciados (fechar apostas: 1min, pagamentos: 2min, placares API: 10min)');
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
