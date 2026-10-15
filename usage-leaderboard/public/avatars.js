'use strict';

window.UsageAvatars = (() => {
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  function source(user) {
    if (user.source === 'simulation' || typeof user.avatar !== 'string') return null;
    const value = user.avatar.trim();
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function content(user) {
    const url = source(user);
    return '<i data-lucide="user-round"></i>' + (url ? `<img src="${escape(url)}" alt="" decoding="async" referrerpolicy="no-referrer">` : '');
  }
  document.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.parentElement?.classList.contains('user-avatar')) event.target.remove();
  }, true);
  return {
    html(user, size) { return `<span class="user-avatar" style="--avatar-size:${size}px" aria-hidden="true">${content(user)}</span>`; },
    set(element, user) { element.innerHTML = content(user); }
  };
})();
