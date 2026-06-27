(function () {
  const POLL_NORMAL_MS = 30000;
  const POLL_LIVE_MS = 15000;

  const container = document.getElementById('home-dynamic');
  if (!container) return;

  const statusEl = document.getElementById('home-refresh-status');
  const statusText = statusEl && statusEl.querySelector('.home-refresh-text');
  let timer = null;
  let busy = false;

  function getPollInterval() {
    const hasLive = container.dataset.hasLive === '1' || container.querySelector('.game-row-live');
    return hasLive ? POLL_LIVE_MS : POLL_NORMAL_MS;
  }

  function saveOpenDetails() {
    const gameIds = [...container.querySelectorAll('details[open][data-game-id]')].map((d) => d.dataset.gameId);
    const featuredBets = [...container.querySelectorAll('.featured-bets-btn[aria-expanded="true"]')].map(
      (b) => b.getAttribute('aria-controls')
    );
    return { gameIds, featuredBets };
  }

  function restoreOpenDetails(state) {
    const ids = state && state.gameIds ? state.gameIds : state;
    const featuredBets = state && state.featuredBets ? state.featuredBets : [];
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const el = container.querySelector(`details[data-game-id="${id}"]`);
      if (el) el.open = true;
    });
    featuredBets.forEach((panelId) => {
      const panel = panelId ? document.getElementById(panelId) : null;
      const btn = panelId ? container.querySelector(`.featured-bets-btn[aria-controls="${panelId}"]`) : null;
      if (panel && btn) {
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  function setStatus(text, fresh) {
    if (!statusText) return;
    statusText.textContent = text;
    if (statusEl) {
      statusEl.classList.toggle('is-fresh', Boolean(fresh));
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refreshHome, getPollInterval());
  }

  async function refreshHome() {
    if (document.hidden || busy) {
      schedule();
      return;
    }

    busy = true;
    try {
      const res = await fetch('/api/home', {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) return;

      const openState = saveOpenDetails();
      const html = await res.text();
      if (!html.trim()) return;

      container.innerHTML = html;
      container.dataset.hasLive = container.querySelector('.game-row-live') ? '1' : '0';
      restoreOpenDetails(openState);

      const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setStatus('Atualizado às ' + now, true);
      setTimeout(() => setStatus('Atualização automática ativa', false), 2500);
    } catch (_) {
      /* silencioso — tenta de novo no próximo ciclo */
    } finally {
      busy = false;
      schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
    } else {
      refreshHome();
    }
  });

  schedule();
})();
