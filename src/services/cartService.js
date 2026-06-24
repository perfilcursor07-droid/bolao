function ensureCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function placarKey(p) {
  return `${p.home}-${p.away}`;
}

function mergePlacares(existing, incoming) {
  const map = new Map();
  for (const p of existing) map.set(placarKey(p), p);
  for (const p of incoming) map.set(placarKey(p), p);
  return [...map.values()];
}

function getCart(req) {
  return ensureCart(req);
}

function getCartCount(req) {
  const cart = getCart(req);
  return cart.reduce((sum, item) => sum + item.placares.length, 0);
}

function getCartTotalCents(req) {
  const cart = getCart(req);
  return cart.reduce((sum, item) => sum + item.entry_fee_cents * item.placares.length, 0);
}

function addToCart(req, game, placares) {
  if (!placares.length) return { error: 'no_placares' };

  const cart = ensureCart(req);
  const existing = cart.find((item) => item.gameId === game.id);

  if (existing) {
    existing.placares = mergePlacares(existing.placares, placares);
    existing.title = game.title;
    existing.home_team = game.home_team;
    existing.away_team = game.away_team;
    existing.entry_fee_cents = game.entry_fee_cents;
  } else {
    cart.push({
      gameId: game.id,
      title: game.title,
      home_team: game.home_team,
      away_team: game.away_team,
      entry_fee_cents: game.entry_fee_cents,
      placares: [...placares],
    });
  }

  return { ok: true, count: getCartCount(req) };
}

function removeGameFromCart(req, gameId) {
  const cart = ensureCart(req);
  const id = parseInt(gameId, 10);
  req.session.cart = cart.filter((item) => item.gameId !== id);
}

function removePlacarFromCart(req, gameId, placarIndex) {
  const cart = ensureCart(req);
  const id = parseInt(gameId, 10);
  const idx = parseInt(placarIndex, 10);
  const item = cart.find((i) => i.gameId === id);
  if (!item || idx < 0 || idx >= item.placares.length) return;

  item.placares.splice(idx, 1);
  if (item.placares.length === 0) {
    req.session.cart = cart.filter((i) => i.gameId !== id);
  }
}

function clearCart(req) {
  req.session.cart = [];
}

module.exports = {
  getCart,
  getCartCount,
  getCartTotalCents,
  addToCart,
  removeGameFromCart,
  removePlacarFromCart,
  clearCart,
};
