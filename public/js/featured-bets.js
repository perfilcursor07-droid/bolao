(function () {
  const root = document.querySelector('.home-container');
  if (!root) return;

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.featured-bets-btn');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const panelId = btn.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) return;

    const willOpen = btn.getAttribute('aria-expanded') !== 'true';

    document.querySelectorAll('.featured-bets-btn[aria-expanded="true"]').forEach((other) => {
      if (other === btn) return;
      other.setAttribute('aria-expanded', 'false');
      const otherPanel = document.getElementById(other.getAttribute('aria-controls'));
      if (otherPanel) otherPanel.hidden = true;
    });

    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    panel.hidden = !willOpen;
  });
})();
