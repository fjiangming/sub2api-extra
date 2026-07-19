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
  const headerUserEmail = document.getElementById('header-user-email');
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

  async function detectSub2ApiTab() {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url || !tab.id) continue;
        try {
          const u = new URL(tab.url);

          // 特征 1：顶层 URL 直接带 token 参数
          if (u.searchParams.has('token')) {
            const serverUrl = u.searchParams.get('src_host') || u.origin;
            return { origin: serverUrl, tabId: tab.id, token: u.searchParams.get('token') };
          }

          // 特征 2：路径包含 /admin（Sub2API 原始管理后台）
          // 特征 3：路径包含 /custom/（Sub2API 自定义页面，sub2api-extra 嵌入其中）
          if (u.pathname.startsWith('/admin') || u.pathname.startsWith('/custom/')) {
            // 深入扫描该标签页所有 iframe，寻找带 token 的嵌入页面
            try {
              const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
              for (const frame of (frames || [])) {
                if (!frame.url) continue;
                try {
                  const fu = new URL(frame.url);
                  if (fu.searchParams.has('token')) {
                    const serverUrl = fu.searchParams.get('src_host') || u.origin;
                    // extraOrigin: iframe 自身的 origin，即 sub2api-extra 服务地址
                    const extraOrigin = fu.origin !== u.origin ? fu.origin : null;
                    return { origin: serverUrl, extraOrigin, tabId: tab.id, token: fu.searchParams.get('token') };
                  }
                } catch {}
              }
            } catch {}
            // 即使 iframe 里没找到 token，这依然是一个 Sub2API 页面
            return { origin: u.origin, tabId: tab.id };
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

  async function detectSub2ApiUrl() {
    const result = await detectSub2ApiTab();
    return result ? result.origin : null;
  }

  /**
   * 尝试从已打开的 Sub2API 标签页读取 localStorage 中的 auth_token，
   * 实现免登录自动认证。
   */
  async function tryAutoLoginFromSub2ApiTab() {
    const detected = await detectSub2ApiTab();
    if (!detected) return null;

    // 优先使用 URL 中捕获的 token（适用于 sub2api-extra 新版嵌入式前端）
    if (detected.token) {
      return { token: detected.token, serverUrl: detected.origin, extraServerUrl: detected.extraOrigin || null };
    }

    try {
      // 降级尝试从 localStorage 读取（适用于 Sub2API 原始管理后台）
      const results = await chrome.scripting.executeScript({
        target: { tabId: detected.tabId },
        func: () => localStorage.getItem('auth_token'),
      });
      const token = results?.[0]?.result;
      if (token) {
        return { token, serverUrl: detected.origin };
      }
    } catch {
      // 脚本注入失败（如权限不足）时静默降级
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
    if (headerUserEmail) headerUserEmail.textContent = '';
  }

  function hideLogin(email) {
    document.body.classList.remove('auth-pending');
    if (headerUserEmail) headerUserEmail.textContent = email || '';
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
    console.log('[Auth] initAuth 启动, 已存储凭据:', stored ? { serverUrl: stored.serverUrl, email: stored.email, hasToken: !!stored.token, hasPassword: !!stored.password } : null);

    if (stored && stored.token && stored.serverUrl) {
      // 回填上次的服务端地址和邮箱
      if (inputServerUrl) inputServerUrl.value = stored.serverUrl;
      if (inputEmail) inputEmail.value = stored.email || '';

      // 验证 token 是否仍然有效
      const userInfo = await verifyToken(stored.serverUrl, stored.token);
      if (userInfo && (userInfo.id || userInfo.username)) {
        console.log('[Auth] ✅ 已存储 Token 仍有效，直接进入主面板');
        hideLogin(userInfo.email || stored.email);
        return;
      }

      console.log('[Auth] ⚠️ 已存储 Token 已失效');

      // ── Token 已过期，尝试用存储的账密静默续期 ──
      if (stored.email && stored.password) {
        console.log('[Auth] 🔄 尝试用存储的账密静默续期...');
        try {
          const result = await loginRequest(stored.serverUrl, stored.email, stored.password);
          const newToken = result.data?.access_token || result.data?.token || result.access_token || result.token;
          if (newToken) {
            const newUserInfo = await verifyToken(stored.serverUrl, newToken);
            if (newUserInfo && (newUserInfo.id || newUserInfo.username)) {
              await setStoredAuth({
                token: newToken,
                serverUrl: stored.serverUrl,
                extraServerUrl: stored.extraServerUrl || null,
                email: stored.email,
                password: stored.password,
                loginAt: Date.now(),
              });
              try { chrome.runtime.sendMessage({ type: 'SYNC_REMOTE_SETTINGS' }); } catch {}
              console.log('[Auth] ✅ 静默续期成功，已获取新 Token');
              hideLogin(newUserInfo.email || stored.email);
              return;
            }
          }
        } catch (e) {
          console.warn('[Auth] ❌ 静默续期失败:', e.message || e);
        }
      }
    }

    // ── 尝试从已打开的 Sub2API 标签页自动登录 ──
    console.log('[Auth] 🔍 尝试从浏览器标签页自动获取 Token...');
    const autoLogin = await tryAutoLoginFromSub2ApiTab();
    if (autoLogin) {
      console.log('[Auth] 📎 从标签页获取到 Token, 服务端:', autoLogin.serverUrl, ', Extra:', autoLogin.extraServerUrl);
      const userInfo = await verifyToken(autoLogin.serverUrl, autoLogin.token);
      if (userInfo && (userInfo.id || userInfo.username)) {
        await setStoredAuth({
          token: autoLogin.token,
          serverUrl: autoLogin.serverUrl,
          extraServerUrl: autoLogin.extraServerUrl || null,
          email: userInfo.email || '',
          loginAt: Date.now(),
        });
        // 触发后台同步配置
        try { chrome.runtime.sendMessage({ type: 'SYNC_REMOTE_SETTINGS' }); } catch {}
        console.log('[Auth] ✅ 从标签页自动登录成功');
        hideLogin(userInfo.email);
        return;
      } else {
        console.log('[Auth] ⚠️ 标签页 Token 验证失败');
      }
    } else {
      console.log('[Auth] ℹ️ 未检测到已打开的 Sub2API 标签页');
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

        // 尝试从浏览器标签页发现 sub2api-extra 地址
        let extraServerUrl = null;
        try {
          const detected = await detectSub2ApiTab();
          if (detected?.extraOrigin) {
            extraServerUrl = detected.extraOrigin;
            console.log('[Auth] 📎 手动登录时发现 sub2api-extra 地址:', extraServerUrl);
          }
        } catch {}

        // 持久化登录态（含密码，供内容脚本降级登录时使用）
        await setStoredAuth({
          token,
          serverUrl,
          extraServerUrl,
          email,
          password,
          loginAt: Date.now(),
        });

        // 登录成功后立刻触发后台获取服务端配置，以便用户打开侧边栏时配置已就绪
        try {
          chrome.runtime.sendMessage({ type: 'SYNC_REMOTE_SETTINGS' });
        } catch (e) {
          // 忽略扩展通信可能抛出的异常
        }

        hideLogin(userInfo.email || email);
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
