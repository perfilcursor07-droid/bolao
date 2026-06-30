const pool = require('../config/database');

const FIRST_BET_COMMISSION_CENTS = 50;
const MIN_PAYOUT_CENTS = 2000;

const MILESTONES = [
  { count: 5, bonusCents: 200 },
  { count: 10, bonusCents: 500 },
  { count: 25, bonusCents: 1500 },
  { count: 50, bonusCents: 4000 },
];

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
}

function slugFromName(name) {
  const base = String(name || 'BOLAO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return base || 'BOLAO';
}

async function generateUniqueCode(preferred) {
  let base = normalizeCode(preferred) || 'BOLAO';
  if (base.length < 4) base = `${base}BOL`;

  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = attempt === 0 ? '' : String(Math.floor(10 + Math.random() * 90));
    const code = `${base}${suffix}`.slice(0, 20);
    const [rows] = await pool.query('SELECT id FROM affiliates WHERE code = ? LIMIT 1', [code]);
    if (rows.length === 0) return code;
  }

  return `REF${Date.now().toString(36).toUpperCase().slice(-8)}`;
}

async function findActiveAffiliateByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const [rows] = await pool.query(
    `SELECT a.*, u.name as user_name
     FROM affiliates a JOIN users u ON u.id = a.user_id
     WHERE a.code = ? AND a.status = 'active' LIMIT 1`,
    [normalized]
  );
  return rows[0] || null;
}

async function getAffiliateByUserId(userId) {
  const [rows] = await pool.query('SELECT * FROM affiliates WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function captureReferralCode(req, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;

  const affiliate = await findActiveAffiliateByCode(normalized);
  if (!affiliate) return false;

  if (req.session.user && req.session.user.id === affiliate.user_id) {
    return false;
  }

  req.session.affiliateRef = normalized;
  return true;
}

async function bindReferralToUser(userId, affiliateCode) {
  const affiliate = await findActiveAffiliateByCode(affiliateCode);
  if (!affiliate || affiliate.user_id === userId) return false;

  const [existing] = await pool.query(
    'SELECT id FROM affiliate_referrals WHERE referred_user_id = ? LIMIT 1',
    [userId]
  );
  if (existing.length > 0) return false;

  const [paidBefore] = await pool.query(
    "SELECT id FROM payments WHERE user_id = ? AND status = 'paid' LIMIT 1",
    [userId]
  );
  if (paidBefore.length > 0) return false;

  await pool.query(
    'INSERT INTO affiliate_referrals (affiliate_id, referred_user_id) VALUES (?, ?)',
    [affiliate.id, userId]
  );
  return true;
}

async function tryBindSessionReferral(req, userId) {
  const code = req.session?.affiliateRef;
  if (!code) return false;
  return bindReferralToUser(userId, code);
}

async function applyForAffiliate(userId, preferredCode) {
  const existing = await getAffiliateByUserId(userId);
  if (existing) {
    return { error: 'already_applied', affiliate: existing };
  }

  const [userRows] = await pool.query('SELECT name, cpf FROM users WHERE id = ?', [userId]);
  if (userRows.length === 0) return { error: 'user_not_found' };
  const user = userRows[0];

  if (!user.cpf || String(user.cpf).trim().length < 5) {
    return { error: 'pix_required' };
  }

  const code = await generateUniqueCode(preferredCode || slugFromName(user.name));
  const [result] = await pool.query(
    'INSERT INTO affiliates (user_id, code, status) VALUES (?, ?, ?)',
    [userId, code, 'pending']
  );

  const [rows] = await pool.query('SELECT * FROM affiliates WHERE id = ?', [result.insertId]);
  return { affiliate: rows[0] };
}

async function creditAffiliate(connection, affiliateId, data) {
  const { amountCents, type, referredUserId, paymentId, milestoneCount, notes } = data;

  await connection.query(
    `INSERT INTO affiliate_commissions
      (affiliate_id, referred_user_id, payment_id, type, milestone_count, amount_cents, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'available', ?)`,
    [affiliateId, referredUserId || null, paymentId || null, type, milestoneCount || null, amountCents, notes || null]
  );

  await connection.query(
    `UPDATE affiliates
     SET balance_cents = balance_cents + ?, total_earned_cents = total_earned_cents + ?
     WHERE id = ?`,
    [amountCents, amountCents, affiliateId]
  );
}

async function checkMilestones(connection, affiliateId) {
  const [affRows] = await connection.query(
    'SELECT total_paid_referrals FROM affiliates WHERE id = ? FOR UPDATE',
    [affiliateId]
  );
  if (affRows.length === 0) return;

  const paidCount = affRows[0].total_paid_referrals;

  for (const milestone of MILESTONES) {
    if (paidCount < milestone.count) continue;

    const [claimed] = await connection.query(
      'SELECT id FROM affiliate_milestone_claims WHERE affiliate_id = ? AND milestone_count = ? LIMIT 1',
      [affiliateId, milestone.count]
    );
    if (claimed.length > 0) continue;

    await connection.query(
      'INSERT INTO affiliate_milestone_claims (affiliate_id, milestone_count, amount_cents) VALUES (?, ?, ?)',
      [affiliateId, milestone.count, milestone.bonusCents]
    );

    await creditAffiliate(connection, affiliateId, {
      amountCents: milestone.bonusCents,
      type: 'milestone',
      milestoneCount: milestone.count,
      notes: `Bônus meta ${milestone.count} indicações pagas`,
    });
  }
}

async function processAffiliateCommissionOnPayment(connection, payment) {
  const [referrals] = await connection.query(
    `SELECT ar.*, a.status as affiliate_status, a.user_id as affiliate_user_id
     FROM affiliate_referrals ar
     JOIN affiliates a ON a.id = ar.affiliate_id
     WHERE ar.referred_user_id = ? AND ar.first_paid_at IS NULL
     LIMIT 1`,
    [payment.user_id]
  );

  if (referrals.length === 0) return;

  const referral = referrals[0];
  if (referral.affiliate_status !== 'active') return;
  if (referral.affiliate_user_id === payment.user_id) return;

  const [paidCount] = await connection.query(
    "SELECT COUNT(*) as c FROM payments WHERE user_id = ? AND status = 'paid'",
    [payment.user_id]
  );
  if (paidCount[0].c !== 1) return;

  const [dup] = await connection.query(
    `SELECT id FROM affiliate_commissions
     WHERE affiliate_id = ? AND payment_id = ? AND type = 'first_bet' LIMIT 1`,
    [referral.affiliate_id, payment.id]
  );
  if (dup.length > 0) return;

  await connection.query(
    'UPDATE affiliate_referrals SET first_paid_at = NOW() WHERE id = ?',
    [referral.id]
  );

  await connection.query(
    'UPDATE affiliates SET total_paid_referrals = total_paid_referrals + 1 WHERE id = ?',
    [referral.affiliate_id]
  );

  await creditAffiliate(connection, referral.affiliate_id, {
    amountCents: FIRST_BET_COMMISSION_CENTS,
    type: 'first_bet',
    referredUserId: payment.user_id,
    paymentId: payment.id,
    notes: 'Primeira aposta paga do indicado',
  });

  await checkMilestones(connection, referral.affiliate_id);
}

async function getAffiliateDashboard(userId) {
  const affiliate = await getAffiliateByUserId(userId);
  if (!affiliate) return null;

  const [referrals] = await pool.query(
    `SELECT ar.*, u.name as referred_name,
      (SELECT COUNT(*) FROM payments p WHERE p.user_id = ar.referred_user_id AND p.status = 'paid') as paid_count,
      (SELECT COALESCE(SUM(ac.amount_cents), 0) FROM affiliate_commissions ac
       WHERE ac.affiliate_id = ar.affiliate_id AND ac.referred_user_id = ar.referred_user_id) as earned_cents
     FROM affiliate_referrals ar
     JOIN users u ON u.id = ar.referred_user_id
     WHERE ar.affiliate_id = ?
     ORDER BY ar.created_at DESC
     LIMIT 50`,
    [affiliate.id]
  );

  const [commissions] = await pool.query(
    `SELECT * FROM affiliate_commissions
     WHERE affiliate_id = ?
     ORDER BY created_at DESC
     LIMIT 30`,
    [affiliate.id]
  );

  const [user] = await pool.query('SELECT name, cpf, phone FROM users WHERE id = ?', [userId]);

  const nextMilestone = MILESTONES.find((m) => affiliate.total_paid_referrals < m.count) || null;

  return {
    affiliate,
    referrals,
    commissions,
    user: user[0],
    milestones: MILESTONES,
    nextMilestone,
    minPayoutCents: MIN_PAYOUT_CENTS,
    firstBetCommissionCents: FIRST_BET_COMMISSION_CENTS,
  };
}

async function getUserDashboard(userId) {
  const [betStats] = await pool.query(
    `SELECT COUNT(*) as total_bets,
            SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as wins,
            COALESCE(SUM(CASE WHEN is_winner THEN prize_amount_cents ELSE 0 END), 0) as total_prizes
     FROM bets WHERE user_id = ?`,
    [userId]
  );

  const [pendingPayments] = await pool.query(
    `SELECT COUNT(*) as c FROM payments
     WHERE user_id = ? AND status = 'pending' AND qr_code_text IS NOT NULL AND qr_code_text != ''`,
    [userId]
  );

  const [recentBets] = await pool.query(
    `SELECT b.*, g.title, g.home_team, g.away_team, g.status as game_status
     FROM bets b JOIN games g ON g.id = b.game_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 5`,
    [userId]
  );

  const [pendingPaymentsList] = await pool.query(
    `SELECT p.id, p.amount_cents, p.created_at, g.title, g.home_team, g.away_team
     FROM payments p JOIN games g ON g.id = p.game_id
     WHERE p.user_id = ? AND p.status = 'pending'
       AND p.qr_code_text IS NOT NULL AND p.qr_code_text != ''
     ORDER BY p.created_at DESC LIMIT 5`,
    [userId]
  );

  const affiliate = await getAffiliateByUserId(userId);
  const affiliateDashboard = affiliate ? await getAffiliateDashboard(userId) : null;

  return {
    stats: {
      totalBets: betStats[0]?.total_bets || 0,
      wins: betStats[0]?.wins || 0,
      totalPrizes: betStats[0]?.total_prizes || 0,
      pendingPayments: pendingPayments[0]?.c || 0,
    },
    recentBets,
    pendingPaymentsList,
    affiliate,
    affiliateDashboard,
  };
}

async function listAffiliatesForAdmin() {
  const [rows] = await pool.query(
    `SELECT a.*, u.name, u.email, u.phone, u.cpf,
      (SELECT COUNT(*) FROM affiliate_referrals ar WHERE ar.affiliate_id = a.id) as referral_count
     FROM affiliates a
     JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC`
  );
  return rows;
}

async function setAffiliateStatus(affiliateId, status) {
  const allowed = ['active', 'rejected', 'suspended', 'pending'];
  if (!allowed.includes(status)) return false;
  await pool.query('UPDATE affiliates SET status = ? WHERE id = ?', [status, affiliateId]);
  return true;
}

async function markAffiliatePayoutPaid(affiliateId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      'SELECT balance_cents FROM affiliates WHERE id = ? FOR UPDATE',
      [affiliateId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return { error: 'not_found' };
    }

    const payout = rows[0].balance_cents;
    if (payout <= 0) {
      await connection.rollback();
      return { error: 'sem_saldo' };
    }

    await connection.query(
      'UPDATE affiliates SET balance_cents = 0 WHERE id = ?',
      [affiliateId]
    );

    await connection.query(
      `UPDATE affiliate_commissions SET status = 'paid', paid_at = NOW()
       WHERE affiliate_id = ? AND status = 'available'`,
      [affiliateId]
    );

    await connection.commit();
    return { paid: payout };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  FIRST_BET_COMMISSION_CENTS,
  MIN_PAYOUT_CENTS,
  MILESTONES,
  normalizeCode,
  findActiveAffiliateByCode,
  getAffiliateByUserId,
  captureReferralCode,
  bindReferralToUser,
  tryBindSessionReferral,
  applyForAffiliate,
  processAffiliateCommissionOnPayment,
  getAffiliateDashboard,
  getUserDashboard,
  listAffiliatesForAdmin,
  setAffiliateStatus,
  markAffiliatePayoutPaid,
};
