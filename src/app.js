const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const session = require('express-session');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const gamesRoutes = require('./routes/games');
const paymentRoutes = require('./routes/payment');
const { startCronJobs } = require('./services/cronJobs');
const { formatCents } = require('./routes/games');
const { translateTeamName } = require('./utils/teamNamesPt');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'bolao-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.formatCents = formatCents;
  res.locals.teamPt = translateTeamName;
  next();
});

app.use('/', gamesRoutes);
app.use('/', authRoutes);
app.use('/admin', adminRoutes);
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
