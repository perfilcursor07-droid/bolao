const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const session = require('express-session');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const gamesRoutes = require('./routes/games');
const cartRoutes = require('./routes/cart');
const affiliateRoutes = require('./routes/affiliate');
const paymentRoutes = require('./routes/payment');
const { startCronJobs } = require('./services/cronJobs');
const { formatCents } = require('./routes/games');
const { translateTeamName } = require('./utils/teamNamesPt');
const { formatGameDateBR, toDatetimeLocalBR, toMySQLDateTime } = require('./utils/dateTime');
const { getCartCount } = require('./services/cartService');
const { getPendingPaymentsCount } = require('./services/paymentsService');
const { closeExpiredOpenGames, finalizeClosedGamesWithScores, isBettingOpen, hasGameStarted, BETTING_CLOSE_MINUTES } = require('./services/gameStatusService');
const { captureReferralCode, tryBindSessionReferral } = require('./services/affiliateService');
const { SYSTEM_FEE_RATE, NO_WINNER_FEE_RATE } = require('./services/prizeService');

const app = express();

let lastGameStatusCheck = 0;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(async (req, res, next) => {
  const now = Date.now();
  if (now - lastGameStatusCheck > 30000) {
    lastGameStatusCheck = now;
    try {
      await closeExpiredOpenGames();
      await finalizeClosedGamesWithScores();
    } catch (err) {
      console.error('[gameStatus] Erro ao fechar jogos:', err.message);
    }
  }
  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'bolao-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.use(async (req, res, next) => {
  if (req.query.ref) {
    try {
      await captureReferralCode(req, req.query.ref);
    } catch {
      /* ignora ref inválido */
    }
  }
  if (req.session.user && req.session.affiliateRef) {
    try {
      await tryBindSessionReferral(req, req.session.user.id);
    } catch {
      /* ignora */
    }
  }
  next();
});

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.formatCents = formatCents;
  res.locals.teamPt = translateTeamName;
  res.locals.gameDateBR = formatGameDateBR;
  res.locals.firstName = (name) => {
    if (!name || typeof name !== 'string') return '—';
    const part = name.trim().split(/\s+/)[0];
    return part || '—';
  };
  res.locals.toDatetimeLocalBR = toDatetimeLocalBR;
  res.locals.toMySQLDateTime = toMySQLDateTime;
  res.locals.isBettingOpen = isBettingOpen;
  res.locals.hasGameStarted = hasGameStarted;
  res.locals.bettingCloseMinutes = BETTING_CLOSE_MINUTES;
  res.locals.systemFeePercent = Math.round(SYSTEM_FEE_RATE * 100);
  res.locals.prizeNetPercent = 100 - res.locals.systemFeePercent;
  res.locals.noWinnerFeePercent = Math.round(NO_WINNER_FEE_RATE * 100);
  res.locals.noWinnerRefundPercent = 100 - res.locals.noWinnerFeePercent;
  res.locals.cartCount = 0;
  res.locals.pendingPaymentsCount = 0;

  if (req.session.user) {
    try {
      res.locals.cartCount = getCartCount(req);
      res.locals.pendingPaymentsCount = await getPendingPaymentsCount(req.session.user.id);
    } catch {
      res.locals.cartCount = 0;
      res.locals.pendingPaymentsCount = 0;
    }
  }

  next();
});

app.use('/', gamesRoutes);
app.use('/', cartRoutes);
app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', affiliateRoutes);
app.use('/payment', paymentRoutes);
app.use('/api/payment', paymentRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Página não encontrada',
    message: 'A página que você procura não existe.',
    user: req.session.user || null,
  });
});

module.exports = app;
