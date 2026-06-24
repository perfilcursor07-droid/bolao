function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    const gameMatch = req.originalUrl.match(/\/games\/(\d+)/);
    if (gameMatch) {
      return res.redirect(`/games/${gameMatch[1]}/participar`);
    }
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Acesso negado',
      message: 'Você não tem permissão para acessar esta área.',
      user: req.session.user,
    });
  }
  next();
}

function requireGuest(req, res, next) {
  if (req.session.user) {
    return res.redirect('/');
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireGuest };
