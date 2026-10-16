'use strict';

const state = { session: '', csrf: '' };
const query = new URLSearchParams(location.search);
let upstreamToken = query.get('token') || query.get('access_token') || '';
for (const key of ['token', 'access_token', 'user_id', 'src_host', 'src_url']) query.delete(key);
history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : ''));

function saveSession(token) {
  state.session = token;
  try {
    if (token) sessionStorage.setItem('usage-leaderboard.session', token);
    else sessionStorage.removeItem('usage-leaderboard.session');
  } catch { /* The HttpOnly cookie remains available when storage is restricted. */ }
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(state.session ? { authorization: `Session ${state.session}` } : {}), ...options.headers };
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method)) {
    headers['content-type'] = 'application/json';
    if (state.csrf) headers['x-csrf-token'] = state.csrf;
  }
  let response;
  try {
    response = await fetch(`/api/${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store',
      signal: options.signal || AbortSignal.timeout(60000) });
  } catch (error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    throw new Error('暂时无法连接用量服务，请稍后重试');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || '暂时无法获取数据，请稍后重试');
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  if (!payload) throw new Error('用量服务返回了无效响应，请稍后重试');
  return payload;
}

let toastTimer;
function notify(message) {
  const toast = document.getElementById('toast');
  toast.querySelector('span').textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function showFailure(error) {
  const loading = document.getElementById('admin-loading');
  loading.replaceChildren();
  loading.hidden = false;
  loading.textContent = error.status === 401
    ? '请从 Sub2API 管理员菜单进入排行设置'
    : error.status === 403 ? '此页面仅限 Sub2API 管理员访问' : error.message || '暂时无法连接用量服务';
  if (![401, 403].includes(error.status)) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary-action';
    retry.textContent = '重新加载';
    retry.addEventListener('click', initialize);
    loading.append(retry);
  }
}

async function initialize() {
  const loading = document.getElementById('admin-loading');
  loading.hidden = false;
  loading.textContent = '正在验证管理员身份';
  try {
    if (!state.session) {
      try { state.session = sessionStorage.getItem('usage-leaderboard.session') || ''; } catch {}
    }
    let session;
    if (upstreamToken) {
      saveSession('');
      session = await api('auth/sso', { method: 'POST', headers: { authorization: `Bearer ${upstreamToken}` }, body: '{}' });
      upstreamToken = '';
    } else session = await api('auth/me');
    saveSession(session.sessionToken);
    const adminSession = await api('admin/session');
    state.csrf = adminSession.csrfToken;
    window.UsageAdmin.configure({ api, notify, onDenied(error) {
      state.csrf = '';
      if (error.status === 401) saveSession('');
      showFailure(error);
    } });
    await window.UsageAdmin.show();
  } catch (error) {
    showFailure(error);
  }
}

window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
initialize();
