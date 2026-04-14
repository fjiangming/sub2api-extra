// sidepanel/login.js — EpointGPT公益注册站 登录认证模块
// 独立于主面板逻辑，负责认证门禁、会话持久化与登录页主题切换
// !! 禁止修改此文件以外的功能性代码 !!

(function () {
  'use strict';

  const AUTH_STORAGE_KEY = 'epointgpt_auth';
  const THEME_STORAGE_KEY = 'multipage-theme';

  // ── DOM References ──

  const loginScreen = document.getElementById('login-screen');
  const loginForm = document.getElementById('login-form');
  const inputServerUrl = document.getElementById('login-server-url');
  const inputEmail = document.getElementById('login-email');
  const inputPwd = document.getElementById('login-password');
  const btnLogin = document.getElementById('btn-login');
  const btnLoginText = document.getElementById('btn-login-text');
  const loginError = document.getElementById('login-error');
  const loginThemeBtn = document.getElementById('btn-login-theme');
  const btnTogglePwd = document.getElementById('btn-login-toggle-pwd');
  const btnLogout = document.getElementById('btn-logout');

  const EYE_OPEN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_CLOSED_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a21.77 21.77 0 0 1 5.06-6.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a21.86 21.86 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>';

  // ── Theme (mirror sidepanel.js initTheme logic) ──

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }

  function initLoginTheme() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      applyTheme(saved);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    }
  }

  // 登录页主题切换按钮
  if (loginThemeBtn) {
    loginThemeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  // 密码可见性切换
  if (btnTogglePwd && inputPwd) {
    btnTogglePwd.innerHTML = EYE_CLOSED_SVG;
    btnTogglePwd.addEventListener('click', () => {
      const isPassword = inputPwd.type === 'password';
      inputPwd.type = isPassword ? 'text' : 'password';
      btnTogglePwd.innerHTML = isPassword ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    });
  }

  // ── Auth Helpers (chrome.storage.local) ──

  function getStoredAuth() {
    return new Promise((resolve) => {
      chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result[AUTH_STORAGE_KEY] || null);
      });
    });
  }

  function setStoredAuth(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [AUTH_STORAGE_KEY]: data }, resolve);
    });
  }

  function clearStoredAuth() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(AUTH_STORAGE_KEY, resolve);
    });
  }

  // ── 自动探测浏览器中已打开的 Sub2API 页面 ──

  async function detectSub2ApiUrl() {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        try {
          const u = new URL(tab.url);
          // 特征 1：URL 带 token 参数（sub2api-extra 前端 / Sub2API 管理面板）
          if (u.searchParams.has('token')) {
            return u.origin;
          }
          // 特征 2：路径包含 /admin（Sub2API 原始管理后台）
          if (u.pathname.startsWith('/admin')) {
            return u.origin;
          }
        } catch {
          // 忽略无效 URL（如 chrome:// 页面）
        }
      }
    } catch {
      // tabs 查询失败时静默降级
    }
    return null;
  }

  // ── Network ──

  async function verifyToken(serverUrl, token) {
    try {
      const resp = await fetch(serverUrl.replace(/\/+$/, '') + '/api/v1/auth/me', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      // sub2api 可能包装在 data 字段内
      return data?.data || data;
    } catch {
      return null;
    }
  }

  async function loginRequest(serverUrl, email, password) {
    const url = serverUrl.replace(/\/+$/, '') + '/api/v1/auth/login';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || data.message || data.detail || '登录失败 (' + resp.status + ')');
    }
    return data;
  }

  // ── UI State ──

  function showLogin() {
    document.body.classList.add('auth-pending');
  }

  function hideLogin() {
    document.body.classList.remove('auth-pending');
  }

  function showLoginError(msg) {
    if (loginError) {
      loginError.textContent = msg;
      loginError.style.display = 'block';
    }
  }

  function hideLoginError() {
    if (loginError) {
      loginError.textContent = '';
      loginError.style.display = 'none';
    }
  }

  function setLoginLoading(loading) {
    if (btnLogin) btnLogin.disabled = loading;
    if (btnLoginText) btnLoginText.textContent = loading ? '验证中...' : '登 录';
    if (inputServerUrl) inputServerUrl.disabled = loading;
    if (inputEmail) inputEmail.disabled = loading;
    if (inputPwd) inputPwd.disabled = loading;
  }

  // ── Init Auth Check ──

  initLoginTheme();

  async function initAuth() {
    const stored = await getStoredAuth();

    if (stored && stored.token && stored.serverUrl) {
      // 回填上次的服务端地址和邮箱
      if (inputServerUrl) inputServerUrl.value = stored.serverUrl;
      if (inputEmail) inputEmail.value = stored.email || '';

      // 验证 token 是否仍然有效
      const userInfo = await verifyToken(stored.serverUrl, stored.token);
      if (userInfo && (userInfo.id || userInfo.username)) {
        // Token 有效 → 直接进入主面板
        hideLogin();
        return;
      }
    }

    // Token 无效或不存在 → 显示登录
    showLogin();

    // 当服务端地址为空时，自动探测浏览器中已打开的 Sub2API 页面
    if (inputServerUrl && !inputServerUrl.value.trim()) {
      const detected = await detectSub2ApiUrl();
      if (detected) {
        inputServerUrl.value = detected;
      }
    }
  }

  initAuth();

  // ── Login Form Submit ──

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideLoginError();

      const serverUrl = (inputServerUrl.value || '').trim();
      const email = (inputEmail.value || '').trim();
      const password = (inputPwd.value || '').trim();

      if (!serverUrl) { showLoginError('请填写服务端地址'); return; }
      if (!email) { showLoginError('请填写邮箱'); return; }
      if (!password) { showLoginError('请填写密码'); return; }

      setLoginLoading(true);
      try {
        const result = await loginRequest(serverUrl, email, password);
        // sub2api 返回格式：{ code: 0, data: { access_token: "..." } }
        const token = result.data?.access_token || result.data?.token || result.access_token || result.token;
        if (!token) {
          throw new Error('服务端返回格式异常，未获取到 Token');
        }

        // 立即验证获取到的 token
        const userInfo = await verifyToken(serverUrl, token);
        if (!userInfo || (!userInfo.id && !userInfo.username)) {
          throw new Error('Token 验证失败，请检查服务端地址是否正确');
        }

        // 持久化登录态
        await setStoredAuth({
          token,
          serverUrl,
          email,
          loginAt: Date.now(),
        });

        // 登录成功后立刻触发后台获取服务端配置，以便用户打开侧边栏时配置已就绪
        try {
          chrome.runtime.sendMessage({ type: 'SYNC_REMOTE_SETTINGS' });
        } catch (e) {
          // 忽略扩展通信可能抛出的异常
        }

        hideLogin();
      } catch (err) {
        showLoginError(err.message || '登录失败，请检查网络和服务状态');
      } finally {
        setLoginLoading(false);
      }
    });
  }

  // ── Logout ──

  async function doLogout() {
    await clearStoredAuth();
    showLogin();
    if (inputPwd) inputPwd.value = '';
    hideLoginError();
  }

  // 暴露给 header 退出登录按钮
  window.epointLogout = doLogout;

  if (btnLogout) {
    btnLogout.addEventListener('click', (e) => {
      e.preventDefault();
      doLogout();
    });
  }

})();
