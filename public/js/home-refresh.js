(function () {
  const POLL_NORMAL_MS = 30000;
  const POLL_LIVE_MS = 8000;

  const container = document.getElementById('home-dynamic');
  if (!container) return;

  let timer = null;
  let busy = false;

  function getPollInterval() {
    const hasLive = container.dataset.hasLive === '1' || container.querySelector('.live-game-card, .game-row-live');
    return hasLive ? POLL_LIVE_MS : POLL_NORMAL_MS;
  }

  function saveOpenDetails() {
    return [...container.querySelectorAll('details[open][data-game-id]')].map((d) => d.dataset.gameId);
  }

  function restoreOpenDetails(ids) {
    ids.forEach((id) => {
      const el = container.querySelector(`details[data-game-id="${id}"]`);
      if (el) el.open = true;
    });
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

      const openIds = saveOpenDetails();
      const html = await res.text();
      if (!html.trim()) return;

      if (typeof window.closeFeaturedBetsModal === 'function') {
        window.closeFeaturedBetsModal();
      }
      if (typeof window.closeFinishedBolaoModal === 'function') {
        window.closeFinishedBolaoModal();
      }

      container.innerHTML = html;
      container.dataset.hasLive = container.querySelector('.live-game-card, .game-row-live') ? '1' : '0';
      restoreOpenDetails(openIds);
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
