(function () {
  const modal = document.getElementById('finished-bolao-modal');
  if (!modal) return;

  const backdrop = modal.querySelector('.bets-modal-backdrop');
  const closeBtn = modal.querySelector('.finished-bolao-modal-close');
  const matchEl = modal.querySelector('.finished-modal-match');
  const badgeEl = modal.querySelector('.finished-modal-badge');
  const bodyEl = modal.querySelector('.finished-bolao-modal-body');
  let lastFocus = null;

  function fillBody(tpl) {
    if (!bodyEl || !tpl) return;
    bodyEl.innerHTML = '';
    if (tpl.tagName === 'TEMPLATE') {
      bodyEl.appendChild(tpl.content.cloneNode(true));
    } else {
      bodyEl.innerHTML = tpl.innerHTML;
    }
  }

  function openModal(btn) {
    const gameId = btn.dataset.gameId;
    const tpl = gameId ? document.getElementById('finished-bolao-data-' + gameId) : null;
    if (!tpl) return;

    lastFocus = btn;
    if (matchEl) matchEl.textContent = btn.dataset.title || btn.dataset.match || '';
    const labelEl = btn.querySelector('.finished-winners-twin-label');
    if (badgeEl) badgeEl.textContent = labelEl ? labelEl.textContent.trim() : btn.textContent.trim();

    fillBody(tpl);

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
    const btn = e.target.closest('.finished-winners-btn, .finished-winners-twin-btn');
    if (!btn) return;
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

  window.closeFinishedBolaoModal = closeModal;
})();
