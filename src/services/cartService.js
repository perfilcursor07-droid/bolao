function ensureCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function sameGameId(a, b) {
  return Number(a) === Number(b);
}

function placarKey(p) {
  return `${Number(p.home)}-${Number(p.away)}`;
}

function mergePlacares(existing, incoming) {
  const map = new Map();
  for (const p of existing) map.set(placarKey(p), { home: Number(p.home), away: Number(p.away) });
  for (const p of incoming) map.set(placarKey(p), { home: Number(p.home), away: Number(p.away) });
  return [...map.values()];
}

function persistCart(req, cart) {
  req.session.cart = cart.map((item) => ({
    ...item,
    gameId: Number(item.gameId),
    placares: item.placares.map((p) => ({ home: Number(p.home), away: Number(p.away) })),
  }));
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
  const gameId = Number(game.id);
  const existing = cart.find((item) => sameGameId(item.gameId, gameId));
  const normalized = placares.map((p) => ({ home: Number(p.home), away: Number(p.away) }));

  if (existing) {
    existing.placares = mergePlacares(existing.placares, normalized);
    existing.title = game.title;
    existing.home_team = game.home_team;
    existing.away_team = game.away_team;
    existing.entry_fee_cents = game.entry_fee_cents;
    existing.gameId = gameId;
  } else {
    cart.push({
      gameId,
      title: game.title,
      home_team: game.home_team,
      away_team: game.away_team,
      entry_fee_cents: game.entry_fee_cents,
      placares: normalized,
    });
  }

  persistCart(req, cart);
  return { ok: true, count: getCartCount(req) };
}

function removeGameFromCart(req, gameId) {
  const id = Number(gameId);
  const cart = ensureCart(req).filter((item) => !sameGameId(item.gameId, id));
  persistCart(req, cart);
}

function removePlacarFromCart(req, gameId, placarIndex) {
  const cart = ensureCart(req);
  const id = Number(gameId);
  const idx = parseInt(placarIndex, 10);
  const item = cart.find((i) => sameGameId(i.gameId, id));
  if (!item || idx < 0 || idx >= item.placares.length) return;

  item.placares.splice(idx, 1);
  const next = item.placares.length === 0
    ? cart.filter((i) => !sameGameId(i.gameId, id))
    : cart.map((i) => (sameGameId(i.gameId, id) ? { ...i, placares: [...i.placares] } : { ...i, placares: [...i.placares] }));

  persistCart(req, next);
}

function removePlacarFromCartByScore(req, gameId, home, away) {
  const id = Number(gameId);
  const h = Number(home);
  const a = Number(away);
  const item = getCart(req).find((i) => sameGameId(i.gameId, id));
  if (!item) return false;

  const idx = item.placares.findIndex((p) => Number(p.home) === h && Number(p.away) === a);
  if (idx < 0) return false;

  removePlacarFromCart(req, id, idx);
  return true;
}

function getCartPlacaresForGame(req, gameId) {
  const id = Number(gameId);
  const item = getCart(req).find((i) => sameGameId(i.gameId, id));
  return item ? item.placares.map((p) => ({ home: Number(p.home), away: Number(p.away) })) : [];
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
  removePlacarFromCartByScore,
  getCartPlacaresForGame,
  clearCart,
};
