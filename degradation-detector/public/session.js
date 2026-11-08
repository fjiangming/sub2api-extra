(() => {
  'use strict';

  let sessionToken = sessionStorage.getItem('degradation-detector.session') || '';
  const $ = id => document.getElementById(id);
  const refreshIcons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });

  function showView(name) {
    $('loading-view').hidden = name !== 'loading';
    $('error-view').hidden = name !== 'error';
    $('app-view').hidden = name !== 'app';
  }

  function toast(message, type = '') {
    const item = document.createElement('div');
    item.className = `toast ${type}`.trim();
    item.textContent = message;
    $('toast-region').append(item);
    setTimeout(() => item.remove(), 4200);
  }

  async function authenticatedFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (sessionToken && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Session ${sessionToken}`;
    }
    if (options.body != null) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      ...options,
      headers,
      cache: 'no-store',
      body: options.body == null || typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
    });
  }

  function payloadError(response, payload) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    return error;
  }

  async function responseError(response) {
    return payloadError(response, await response.json().catch(() => ({})));
  }

  async function api(path, options = {}) {
    const response = await authenticatedFetch(path, options);
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw payloadError(response, payload);
    return payload;
  }

  async function authenticate() {
    const params = new URLSearchParams(location.search);
    const theme = params.get('theme');
    document.documentElement.classList.toggle('dark', theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches));
    const token = params.get('token') || params.get('access_token');
    let session;
    if (token) {
      const url = new URL(location.href);
      for (const key of ['token', 'access_token']) url.searchParams.delete(key);
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      session = await api('/api/auth/sso', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: {}
      });
    } else if (['1', 'readonly'].includes(params.get('demo'))) {
      session = await api('/api/auth/demo', { method: 'POST', body: { readOnly: params.get('demo') === 'readonly' } });
    } else {
      session = await api('/api/auth/me');
    }
    sessionToken = session.sessionToken || sessionToken;
    if (sessionToken) sessionStorage.setItem('degradation-detector.session', sessionToken);
    $('user-name').textContent = session.user?.name || 'Sub2API 用户';
  }

  function mount(refresh, clearResults, refreshId = 'refresh-button') {
    let pollTimer;
    let ready = false;
    function failed(error, initial = false) {
      if (initial || [401, 403].includes(error.status)) {
        clearInterval(pollTimer);
        ready = false;
        clearResults();
        if ([401, 403].includes(error.status)) {
          sessionToken = '';
          sessionStorage.removeItem('degradation-detector.session');
        }
        $('error-message').textContent = error.status === 401
          ? '登录状态无效或已过期，请从 Sub2API 自定义菜单重新打开。'
          : error.message || '页面暂时不可用';
        showView('error');
        refreshIcons();
      } else toast(error.message, 'error');
    }
    async function initialize() {
      clearInterval(pollTimer);
      ready = false;
      showView('loading');
      try {
        await authenticate();
        await refresh();
        ready = true;
        showView('app');
        refreshIcons();
        pollTimer = setInterval(() => {
          if (ready && !document.hidden) refresh().catch(error => failed(error));
        }, 5000);
      } catch (error) { failed(error, true); }
    }
    $(refreshId).addEventListener('click', () => refresh().catch(error => failed(error)));
    $('retry-button').addEventListener('click', initialize);
    initialize();
  }

  window.DetectorSession = { api, authenticatedFetch, responseError, refreshIcons, toast, mount };
})();
