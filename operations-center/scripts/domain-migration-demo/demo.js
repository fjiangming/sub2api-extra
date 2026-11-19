'use strict';

(() => {
  const oldOrigin = 'https://epoint2api.fjmooo.cn';
  const newOrigin = 'https://yunhop.cc';
  let source = new URL(oldOrigin);

  // Local previews may simulate an old URL; the destination origin stays fixed.
  try {
    const current = new URL(window.location.href);
    const candidate = current.hostname === new URL(oldOrigin).hostname
      ? current
      : new URL(current.searchParams.get('from') || '/', oldOrigin);
    if (['http:', 'https:'].includes(candidate.protocol)
      && candidate.hostname === new URL(oldOrigin).hostname
      && !candidate.username && !candidate.password && !candidate.port) {
      source = candidate;
    }
  } catch {
    source = new URL(oldOrigin);
  }

  const destination = new URL(newOrigin);
  destination.pathname = source.pathname;
  destination.search = source.search;
  destination.hash = source.hash;
  document.getElementById('source-url').textContent = source.href;
  document.getElementById('destination-path').textContent = destination.pathname + destination.search + destination.hash;
  document.getElementById('destination-url').href = destination.href;
  document.getElementById('continue-link').href = destination.href;
  document.getElementById('home-link').hidden = destination.href === new URL(newOrigin).href;

  const copy = document.getElementById('copy-address');
  const result = document.getElementById('copy-result');
  let resetTimer;
  let copying = false;
  const refreshIcons = () => window.lucide?.createIcons();
  document.getElementById('copy-control').hidden = false;

  async function copyAddress() {
    if (copying) return;
    copying = true;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(destination.href);
      } else {
        const field = document.createElement('textarea');
        field.value = destination.href;
        field.readOnly = true;
        field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.appendChild(field);
        let copied;
        try {
          field.select();
          copied = document.execCommand('copy');
        } finally {
          field.remove();
          copy.focus({ preventScroll: true });
        }
        if (!copied) throw new Error('Clipboard unavailable');
      }
      clearTimeout(resetTimer);
      result.textContent = '新地址已复制';
      delete result.dataset.error;
      copy.innerHTML = '<i data-lucide="check" aria-hidden="true"></i>';
      copy.setAttribute('aria-label', '新地址已复制');
      refreshIcons();
      resetTimer = setTimeout(() => {
        copy.innerHTML = '<i data-lucide="copy" aria-hidden="true"></i>';
        copy.setAttribute('aria-label', '复制新地址');
        refreshIcons();
      }, 2500);
    } catch {
      clearTimeout(resetTimer);
      copy.innerHTML = '<i data-lucide="copy" aria-hidden="true"></i>';
      copy.setAttribute('aria-label', '复制新地址');
      refreshIcons();
      result.textContent = '复制未完成，请选中上方新地址复制。';
      result.dataset.error = 'true';
    } finally {
      copying = false;
    }
  }

  copy.addEventListener('click', copyAddress);
  refreshIcons();
})();
