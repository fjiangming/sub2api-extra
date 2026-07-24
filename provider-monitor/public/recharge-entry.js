(() => {
  const stage = document.body.dataset.rechargeStage;
  if (stage === 'confirm') {
    const form = document.querySelector('#recharge-entry-form');
    const button = form?.querySelector('button[type="submit"]');
    const status = document.querySelector('#recharge-entry-status');
    let submitting = false;
    form?.addEventListener('submit', (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      if (button) button.disabled = true;
      if (status) status.textContent = '正在建立自动登录会话';
    });
    if (form) window.setTimeout(() => {
      if (!submitting) form.requestSubmit();
    }, 50);
    return;
  }
  if (stage !== 'provider-login') return;

  const form = document.querySelector('#provider-login-form');
  const button = document.querySelector('#provider-login-button');
  const status = document.querySelector('#recharge-entry-status');
  const targetUrl = document.body.dataset.targetUrl;
  const waitMs = Number(document.body.dataset.waitMs) || 2500;
  let running = false;

  const start = () => {
    if (running || !form || !targetUrl) return;
    const popup = window.open('about:blank', 'provider-login-window', 'popup,width=480,height=640');
    if (!popup) {
      if (status) status.textContent = '浏览器阻止了登录窗口';
      if (button) button.hidden = false;
      return;
    }
    running = true;
    try { popup.opener = null; } catch {}
    if (button) button.hidden = true;
    if (status) status.textContent = '正在登录';
    form.submit();
    const startedAt = Date.now();
    const finish = () => {
      try { popup.close(); } catch {}
      window.location.replace(targetUrl);
    };
    const poll = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(poll);
        finish();
        return;
      }
      try {
        if (popup.location.href !== 'about:blank' && popup.location.origin !== window.location.origin) {
          window.clearInterval(poll);
          finish();
          return;
        }
      } catch {
        window.clearInterval(poll);
        finish();
        return;
      }
      if (Date.now() - startedAt >= waitMs) {
        window.clearInterval(poll);
        finish();
      }
    }, 100);
  };

  if (button) button.addEventListener('click', start);
  window.setTimeout(start, 50);
})();
