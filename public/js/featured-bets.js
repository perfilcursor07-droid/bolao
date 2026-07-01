(function () {
  const modal = document.getElementById('featured-bets-modal');
  if (!modal) return;

  const backdrop = modal.querySelector('.bets-modal-backdrop');
  const closeBtn = modal.querySelector('.bets-modal-close');
  const matchEl = modal.querySelector('.bets-modal-match');
  const countEl = modal.querySelector('.bets-modal-count');
  const bodyEl = modal.querySelector('.bets-modal-body');
  let lastFocus = null;

  function openModal(btn) {
    const gameId = btn.dataset.gameId;
    const tpl = gameId ? document.getElementById('featured-bets-data-' + gameId) : null;
    if (!tpl || !bodyEl) return;

    lastFocus = btn;
    if (matchEl) matchEl.textContent = btn.dataset.match || '';
    if (countEl) countEl.textContent = btn.textContent.trim();
    bodyEl.innerHTML = tpl.innerHTML;

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    closeBtn?.focus();
  }

  function closeModal() {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    if (bodyEl) bodyEl.innerHTML = '';
    lastFocus?.focus();
    lastFocus = null;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.featured-bets-btn');
    if (!btn || !document.getElementById('home-dynamic')?.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    openModal(btn);
  });

  backdrop?.addEventListener('click', closeModal);
  closeBtn?.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  window.closeFeaturedBetsModal = closeModal;
})();
