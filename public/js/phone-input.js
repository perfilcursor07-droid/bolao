/**
 * Campo de telefone com país (dropdown customizado) + máscara BR
 */
(function (global) {
  const COUNTRIES_ALL = [
    { dial: '55', iso: 'br', label: 'Brasil', localDigits: 11 },
    { dial: '1', iso: 'us', label: 'Estados Unidos', localDigits: 10 },
    { dial: '351', iso: 'pt', label: 'Portugal', localDigits: 9 },
    { dial: '54', iso: 'ar', label: 'Argentina', localDigits: 10 },
    { dial: '595', iso: 'py', label: 'Paraguai', localDigits: 9 },
    { dial: '598', iso: 'uy', label: 'Uruguai', localDigits: 8 },
    { dial: '591', iso: 'bo', label: 'Bolívia', localDigits: 8 },
    { dial: '44', iso: 'gb', label: 'Reino Unido', localDigits: 10 },
    { dial: '34', iso: 'es', label: 'Espanha', localDigits: 9 },
    { dial: '39', iso: 'it', label: 'Itália', localDigits: 10 },
    { dial: '49', iso: 'de', label: 'Alemanha', localDigits: 11 },
    { dial: '33', iso: 'fr', label: 'França', localDigits: 9 },
    { dial: '81', iso: 'jp', label: 'Japão', localDigits: 10 },
    { dial: '52', iso: 'mx', label: 'México', localDigits: 10 },
  ];

  /** Países habilitados no cadastro — por enquanto só Brasil */
  const COUNTRIES = COUNTRIES_ALL.filter((c) => c.dial === '55');

  function flagImageUrl(iso) {
    return `https://flagcdn.com/24x18/${iso}.png`;
  }

  function createFlagImg(iso, label) {
    const img = document.createElement('img');
    img.src = flagImageUrl(iso);
    img.alt = label || '';
    img.className = 'participar-country-flag-img';
    img.width = 24;
    img.height = 18;
    img.loading = 'lazy';
    img.decoding = 'async';
    return img;
  }

  function cleanDigits(val) {
    return String(val || '').replace(/\D/g, '');
  }

  function getCountry(dial) {
    return COUNTRIES.find((c) => c.dial === String(dial)) || COUNTRIES[0];
  }

  function formatBrazilMask(digits) {
    const d = digits.slice(0, 11);
    if (!d) return '';
    if (d.length <= 2) return `(${d}`;
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  function formatGenericMask(digits, maxLen) {
    return digits.slice(0, maxLen);
  }

  function parseStoredPhone(stored) {
    const digits = cleanDigits(stored);
    if (!digits) return { countryDial: '55', local: '' };

    if (digits.startsWith('55') && digits.length >= 12) {
      const local = digits.slice(2);
      if (local.length === 10 || local.length === 11) {
        return { countryDial: '55', local };
      }
    }

    const sorted = [...COUNTRIES_ALL].sort((a, b) => b.dial.length - a.dial.length);
    for (const c of sorted) {
      if (digits.startsWith(c.dial) && digits.length > c.dial.length + 6) {
        return { countryDial: c.dial, local: digits.slice(c.dial.length) };
      }
    }

    if (digits.length === 10 || digits.length === 11) {
      return { countryDial: '55', local: digits };
    }

    return { countryDial: '55', local: digits };
  }

  function applyMask(input, countryDial) {
    const country = getCountry(countryDial);
    let digits = cleanDigits(input.value);
    const max = country.localDigits || 11;

    if (countryDial === '55') {
      digits = digits.slice(0, 11);
      input.value = formatBrazilMask(digits);
    } else {
      digits = digits.slice(0, max);
      input.value = formatGenericMask(digits, max);
    }

    return digits;
  }

  function getLocalDigits(input, countryDial) {
    return cleanDigits(input.value).slice(0, getCountry(countryDial).localDigits || 15);
  }

  function getFullNumber(countryDial, localDigits) {
    const local = cleanDigits(localDigits);
    if (!local) return '';
    return `${countryDial}${local}`;
  }

  function resolvePickerElements(options) {
    if (options.countryPicker) {
      const root = typeof options.countryPicker === 'string'
        ? document.querySelector(options.countryPicker)
        : options.countryPicker;
      if (!root) return null;
      return {
        root,
        hidden: root.querySelector('input[type="hidden"]'),
        trigger: root.querySelector('.participar-country-trigger'),
        triggerFlag: root.querySelector('.participar-country-trigger .participar-country-flag'),
        triggerLabel: root.querySelector('.participar-country-label'),
        menu: root.querySelector('.participar-country-menu'),
      };
    }

    const legacySelect = typeof options.countrySelect === 'string'
      ? document.querySelector(options.countrySelect)
      : options.countrySelect;
    if (!legacySelect) return null;

    if (legacySelect.classList.contains('participar-country-picker')) {
      return resolvePickerElements({ countryPicker: legacySelect });
    }

    return null;
  }

  function buildCountryPicker(picker, options) {
    const { root, hidden, trigger, triggerFlag, triggerLabel, menu } = picker;
    const singleCountry = COUNTRIES.length === 1;
    let currentDial = '55';
    const onDigitsChange = typeof options.onDigitsChange === 'function' ? options.onDigitsChange : null;
    const phoneInput = typeof options.phoneInput === 'string'
      ? document.querySelector(options.phoneInput)
      : options.phoneInput;

    function updateTrigger(dial) {
      const country = getCountry(dial);
      if (hidden) hidden.value = dial;
      if (triggerFlag) {
        triggerFlag.innerHTML = '';
        triggerFlag.appendChild(createFlagImg(country.iso, country.label));
      }
      if (triggerLabel) {
        triggerLabel.textContent = `+${country.dial} ${country.label}`;
      }
      menu.querySelectorAll('.participar-country-option').forEach((btn) => {
        const selected = btn.dataset.dial === dial;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    }

    function closeMenu() {
      menu.hidden = true;
      root.classList.remove('is-open');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
      menu.hidden = false;
      root.classList.add('is-open');
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
    }

    function setCountry(dial, { clearPhone = false } = {}) {
      currentDial = dial || '55';
      updateTrigger(currentDial);
      if (clearPhone) phoneInput.value = '';
      updatePlaceholder();
      applyMask(phoneInput, currentDial);
      const digits = getLocalDigits(phoneInput, currentDial);
      if (onDigitsChange) onDigitsChange(digits, currentDial);
    }

    function updatePlaceholder() {
      if (currentDial === '55') {
        phoneInput.placeholder = '(11) 98114-1234';
      } else {
        phoneInput.placeholder = getCountry(currentDial).label;
      }
    }

    function handleInput() {
      const digits = applyMask(phoneInput, currentDial);
      if (onDigitsChange) onDigitsChange(digits, currentDial);
    }

    if (singleCountry) {
      root.classList.add('participar-country-picker--single');
      if (menu) menu.hidden = true;
    }

    if (!menu.children.length && !singleCountry) {
      COUNTRIES.forEach((c) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'participar-country-option';
        btn.dataset.dial = c.dial;
        btn.setAttribute('role', 'option');

        const flagSpan = document.createElement('span');
        flagSpan.className = 'participar-country-flag';
        flagSpan.appendChild(createFlagImg(c.iso, c.label));

        const textSpan = document.createElement('span');
        textSpan.className = 'participar-country-option-text';
        textSpan.textContent = `+${c.dial} ${c.label}`;

        btn.appendChild(flagSpan);
        btn.appendChild(textSpan);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const changing = btn.dataset.dial !== currentDial;
          setCountry(btn.dataset.dial, { clearPhone: changing });
          closeMenu();
        });

        li.appendChild(btn);
        menu.appendChild(li);
      });
    }

    if (trigger && !singleCountry) {
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        if (menu.hidden) openMenu();
        else closeMenu();
      });
    }

    if (!singleCountry) {
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) closeMenu();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) closeMenu();
      });
    }

    phoneInput.addEventListener('input', handleInput);
    phoneInput.addEventListener('blur', handleInput);

    setCountry(currentDial);

    if (options.initialPhone) {
      const parsed = parseStoredPhone(options.initialPhone);
      setCountry('55');
      const local = parsed.countryDial === '55' ? parsed.local : cleanDigits(parsed.local);
      phoneInput.value = formatBrazilMask(local);
      if (onDigitsChange) onDigitsChange(local, '55');
    } else if (options.initialLocal) {
      setCountry('55');
      const local = cleanDigits(options.initialLocal);
      phoneInput.value = formatBrazilMask(local);
      if (onDigitsChange) onDigitsChange(local, '55');
    }

    return {
      getCountryDial: () => currentDial,
      getLocalDigits: () => getLocalDigits(phoneInput, currentDial),
      getFullNumber: () => getFullNumber(currentDial, getLocalDigits(phoneInput, currentDial)),
      setFromStored: (stored) => {
        const parsed = parseStoredPhone(stored);
        const local = parsed.countryDial === '55' ? parsed.local : cleanDigits(stored).replace(/^55/, '');
        setCountry('55');
        phoneInput.value = formatBrazilMask(local);
        if (onDigitsChange) onDigitsChange(local, '55');
      },
      isBrazilReady: () => {
        if (currentDial !== '55') return true;
        const d = getLocalDigits(phoneInput, '55');
        return d.length === 11 && d[2] === '9';
      },
    };
  }

  function init(options) {
    const phoneInput = typeof options.phoneInput === 'string'
      ? document.querySelector(options.phoneInput)
      : options.phoneInput;
    if (!phoneInput) return null;

    const picker = resolvePickerElements(options);
    if (picker && picker.root && picker.menu && picker.trigger) {
      return buildCountryPicker(picker, options);
    }

    return null;
  }

  global.PhoneInput = {
    init,
    parseStoredPhone,
    formatBrazilMask,
    getFullNumber,
    COUNTRIES,
  };
})(window);
