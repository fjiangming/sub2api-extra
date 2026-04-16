/**
 * Sub2API Extra — 独立账号管理前端逻辑
 */

// ══════════════════════════════════════
// State
// ══════════════════════════════════════

let currentUser = null;   // { id, username, email, role }
let authToken = null;
let accounts = [];
let groups = [];
let pagination = { page: 1, page_size: 20, total: 0, pages: 1 };
let searchQuery = '';
let searchTimer = null;

// OAuth flow state
let oauthSessionId = '';
let oauthState = '';       // Antigravity / OpenAI / Gemini state param
let oauthCredentials = null; // Credentials obtained via OAuth
let oauthInputMethod = 'oauth-flow'; // 'oauth-flow' or 'manual-key'

// ══════════════════════════════════════
// Init — Parse URL params & authenticate
// ══════════════════════════════════════

(async function init() {
  // Parse URL params from Sub2API iframe
  const params = new URLSearchParams(window.location.search);
  authToken = params.get('token');
  const theme = params.get('theme') || 'light';

  // Apply theme
  if (theme === 'dark') {
    document.body.classList.add('dark');
  }

  // If no token, show error
  if (!authToken) {
    showError('未检测到认证信息。请从 Sub2API 系统中访问此页面。');
    return;
  }

  // Verify identity
  try {
    const resp = await apiFetch('/api/auth/me');
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      if (resp.status === 502) {
        throw new Error('无法连接到 Sub2API 后端服务，请检查 SUB2API_BASE_URL 配置是否正确。');
      } else if (resp.status === 401) {
        throw new Error('Token 无效或已过期，请从 Sub2API 系统中重新访问。');
      } else {
        throw new Error(errData.error || errData.message || `认证失败 (${resp.status})`);
      }
    }
    currentUser = await resp.json();

    // Update UI
    document.getElementById('name-prefix').textContent = currentUser.username + '-';

    // Show main content
    hideLoading();

    // Load data
    await Promise.all([loadAccounts(), loadGroups()]);

    // Setup search
    document.getElementById('search-input').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        pagination.page = 1;
        loadAccounts();
      }, 300);
    });

  } catch (err) {
    showError(err.message || '无法连接到服务，请检查网络和服务状态。');
  }
})();

// ══════════════════════════════════════
// API Helpers
// ══════════════════════════════════════

function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(url, { ...options, headers });
}

// ══════════════════════════════════════
// Data Loading
// ══════════════════════════════════════

async function loadAccounts() {
  try {
    const params = new URLSearchParams({
      page: String(pagination.page),
      page_size: String(pagination.page_size),
    });
    if (searchQuery) params.set('search', searchQuery);

    const resp = await apiFetch(`/api/accounts?${params.toString()}`);
    if (!resp.ok) throw new Error('获取账号列表失败');

    const data = await resp.json();
    accounts = data.items || [];
    pagination.total = data.total || 0;
    pagination.pages = data.pages || 1;

    renderAccounts();
    renderPagination();
    document.getElementById('stats-text').textContent = `共 ${pagination.total} 个账号`;
  } catch (err) {
    console.error(err);
    showToast('error', err.message);
  }
}

async function loadGroups() {
  try {
    const resp = await apiFetch('/api/groups');
    if (!resp.ok) return;

    const data = await resp.json();
    // data could be an array directly or wrapped
    groups = Array.isArray(data) ? data : (data.items || data.data || []);
    renderGroupsCheckboxes();
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

// ══════════════════════════════════════
// Rendering
// ══════════════════════════════════════

function renderAccounts() {
  const tbody = document.getElementById('accounts-tbody');

  if (accounts.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <p>${searchQuery ? '没有找到匹配的账号' : '暂无账号'}</p>
            <p class="empty-sub">${searchQuery ? '尝试其他搜索词' : '点击"添加账号"开始'}</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = accounts.map(acc => {
    // Clean up notes for display (remove ownership tag)
    const displayNotes = (acc.notes || '').trim();

    return `
      <tr>
        <td class="cell-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</td>
        <td><span class="badge badge-platform">${platformLabel(acc.platform)}</span></td>
        <td><span class="badge badge-type">${typeLabel(acc.type)}</span></td>
        <td>${statusBadge(acc.status)}</td>
        <td class="cell-notes" title="${escapeHtml(displayNotes)}">${escapeHtml(displayNotes) || '-'}</td>
        <td class="cell-time">${formatTime(acc.created_at)}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteAccount(${acc.id}, '${escapeHtml(acc.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            删除
          </button>
        </td>
      </tr>`;
  }).join('');
}

function renderPagination() {
  const container = document.getElementById('pagination');

  if (pagination.pages <= 1) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  let html = '';

  // Previous
  html += `<button ${pagination.page <= 1 ? 'disabled' : ''} onclick="goToPage(${pagination.page - 1})">‹</button>`;

  // Page numbers
  const maxVisible = 5;
  let start = Math.max(1, pagination.page - Math.floor(maxVisible / 2));
  let end = Math.min(pagination.pages, start + maxVisible - 1);
  if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

  if (start > 1) {
    html += `<button onclick="goToPage(1)">1</button>`;
    if (start > 2) html += `<button disabled>…</button>`;
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="${i === pagination.page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (end < pagination.pages) {
    if (end < pagination.pages - 1) html += `<button disabled>…</button>`;
    html += `<button onclick="goToPage(${pagination.pages})">${pagination.pages}</button>`;
  }

  // Next
  html += `<button ${pagination.page >= pagination.pages ? 'disabled' : ''} onclick="goToPage(${pagination.page + 1})">›</button>`;

  container.innerHTML = html;
}

function renderGroupsCheckboxes() {
  const container = document.getElementById('groups-container');
  if (groups.length === 0) {
    container.innerHTML = '<span class="loading-text">暂无可用分组</span>';
    return;
  }

  const userEmail = currentUser?.email || '';

  // Only show the group matching current user's email
  const userGroups = groups.filter(g => g.status === 'active' && g.name === userEmail);

  if (userGroups.length === 0) {
    container.innerHTML = '<span class="loading-text">未找到与当前用户匹配的分组</span>';
    return;
  }

  container.innerHTML = userGroups.map(g => `
    <label style="cursor: default;">
      <input type="checkbox" name="group_ids" value="${g.id}" checked onclick="return false" style="pointer-events: none;" />
      <span>${escapeHtml(g.name)}</span>
    </label>
  `).join('');
}

// ══════════════════════════════════════
// Add Account
// ══════════════════════════════════════

function openAddModal() {
  document.getElementById('add-modal').classList.remove('hidden');
  document.getElementById('add-form').reset();
  onPlatformChange(); // Reset credential fields
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

// Platform / Type change → show relevant credential fields
function onPlatformChange() {
  const platform = document.getElementById('form-platform').value;
  const typeSelect = document.getElementById('form-type');

  // Update available types based on platform
  const typeOptions = getTypesForPlatform(platform);
  typeSelect.innerHTML = typeOptions.map(t =>
    `<option value="${t.value}">${t.label}</option>`
  ).join('');

  onTypeChange();
}

function onTypeChange() {
  const platform = document.getElementById('form-platform').value;
  const type = document.getElementById('form-type').value;

  // Hide all credential fields
  document.querySelectorAll('.cred-field').forEach(el => el.classList.add('hidden'));

  // Reset OAuth state on type change
  resetOAuthState();

  // Determine which field(s) to show
  if (isOAuthType(type)) {
    // Show the OAuth flow panel
    document.getElementById('cred-oauth-flow').classList.remove('hidden');
    // Also sync manual key panel content
    updateManualKeyPanel(platform, type);
    onOAuthMethodChange();
  } else {
    // Non-OAuth types: show direct credential field
    const credMap = getCredentialField(platform, type);
    if (credMap) {
      document.getElementById(credMap).classList.remove('hidden');
    }
  }
}

function isOAuthType(type) {
  return type === 'oauth' || type === 'setup-token';
}

function getTypesForPlatform(platform) {
  const types = {
    anthropic: [
      { value: 'oauth', label: 'OAuth (Session Key)' },
      { value: 'setup-token', label: 'Setup Token' },
      { value: 'apikey', label: 'API Key' },
      { value: 'upstream', label: 'Upstream 中继' },
    ],
    openai: [
      { value: 'oauth', label: 'OAuth (Refresh Token)' },
      { value: 'apikey', label: 'API Key' },
      { value: 'upstream', label: 'Upstream 中继' },
    ],
    gemini: [
      { value: 'oauth', label: 'OAuth' },
      { value: 'apikey', label: 'API Key' },
      { value: 'upstream', label: 'Upstream 中继' },
    ],
    antigravity: [
      { value: 'oauth', label: 'OAuth (Session Key)' },
      { value: 'apikey', label: 'API Key' },
      { value: 'upstream', label: 'Upstream 中继' },
      { value: 'bedrock', label: 'AWS Bedrock' },
    ],
  };
  return types[platform] || types.anthropic;
}

function getCredentialField(platform, type) {
  if (type === 'upstream') return 'cred-upstream';
  if (type === 'bedrock') return 'cred-bedrock';
  if (type === 'apikey') return 'cred-api-key';

  // OAuth / setup-token → use oauth flow panel (handled in onTypeChange)
  // This fallback is for manual-key mode
  if (platform === 'anthropic' || platform === 'antigravity') return 'cred-session-key';
  if (platform === 'openai') return 'cred-refresh-token';
  if (platform === 'gemini') return 'cred-gemini-oauth';

  return null;
}

function getManualCredFieldId(platform) {
  if (platform === 'anthropic' || platform === 'antigravity') return 'cred-session-key';
  if (platform === 'openai') return 'cred-refresh-token';
  if (platform === 'gemini') return 'cred-gemini-oauth';
  return null;
}

function updateManualKeyPanel(platform, type) {
  // This sets up which manual input will be shown when user switches to manual mode
  // The actual visibility is controlled by onOAuthMethodChange()
}

function buildCredentials(platform, type) {
  if (type === 'upstream') {
    const creds = { base_url: document.getElementById('form-upstream-url').value.trim() };
    const key = document.getElementById('form-upstream-key').value.trim();
    if (key) creds.api_key = key;
    return creds;
  }

  if (type === 'bedrock') {
    return {
      aws_access_key_id: document.getElementById('form-bedrock-access-key').value.trim(),
      aws_secret_access_key: document.getElementById('form-bedrock-secret-key').value.trim(),
      aws_region: document.getElementById('form-bedrock-region').value.trim() || 'us-east-1',
    };
  }

  if (type === 'apikey') {
    return { api_key: document.getElementById('form-api-key').value.trim() };
  }

  // OAuth / setup-token: check if we have OAuth-obtained credentials
  if (isOAuthType(type) && oauthInputMethod === 'oauth-flow' && oauthCredentials) {
    return oauthCredentials;
  }

  // Manual key mode fallback
  if (platform === 'anthropic' || platform === 'antigravity') {
    return { session_key: document.getElementById('form-session-key').value.trim() };
  }

  if (platform === 'openai') {
    return { refresh_token: document.getElementById('form-refresh-token').value.trim() };
  }

  if (platform === 'gemini') {
    const creds = {};
    const at = document.getElementById('form-gemini-access-token').value.trim();
    const rt = document.getElementById('form-gemini-refresh-token').value.trim();
    const ot = document.getElementById('form-gemini-oauth-type').value;
    if (at) creds.access_token = at;
    if (rt) creds.refresh_token = rt;
    if (ot) creds.oauth_type = ot;
    return creds;
  }

  return {};
}

async function handleAddAccount(e) {
  e.preventDefault();

  const platform = document.getElementById('form-platform').value;
  const type = document.getElementById('form-type').value;
  const name = document.getElementById('form-name').value.trim();
  const notes = document.getElementById('form-notes').value.trim();

  if (!name) {
    showToast('error', '请输入账号名称');
    return;
  }

  const credentials = buildCredentials(platform, type);

  // Validate required credentials
  if (!validateCredentials(platform, type, credentials)) return;

  // Collect selected group IDs
  const groupCheckboxes = document.querySelectorAll('input[name="group_ids"]:checked');
  const groupIds = Array.from(groupCheckboxes).map(cb => parseInt(cb.value));

  const body = {
    user_id: currentUser.id,
    username: currentUser.username,
    name: name,
    platform: platform,
    type: type,
    credentials: credentials,
    notes: notes,
  };
  if (groupIds.length > 0) body.group_ids = groupIds;

  // Submit
  setSubmitting(true);
  try {
    const resp = await apiFetch('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || err.message || err.detail || '创建失败');
    }

    showToast('success', '账号添加成功');
    closeAddModal();
    await loadAccounts();
  } catch (err) {
    showToast('error', err.message);
  } finally {
    setSubmitting(false);
  }
}

function validateCredentials(platform, type, creds) {
  if (type === 'upstream') {
    if (!creds.base_url) { showToast('error', '请输入 Upstream Base URL'); return false; }
    return true;
  }
  if (type === 'bedrock') {
    if (!creds.aws_access_key_id) { showToast('error', '请输入 AWS Access Key ID'); return false; }
    if (!creds.aws_secret_access_key) { showToast('error', '请输入 AWS Secret Access Key'); return false; }
    return true;
  }
  if (type === 'apikey') {
    if (!creds.api_key) { showToast('error', '请输入 API Key'); return false; }
    return true;
  }

  // OAuth / setup-token with OAuth flow
  if (isOAuthType(type) && oauthInputMethod === 'oauth-flow') {
    if (!oauthCredentials || Object.keys(oauthCredentials).length === 0) {
      showToast('error', '请先完成 OAuth 授权流程获取凭据');
      return false;
    }
    return true;
  }

  // Manual key mode
  if (platform === 'anthropic' || platform === 'antigravity') {
    if (!creds.session_key) { showToast('error', '请输入 Session Key'); return false; }
    return true;
  }
  if (platform === 'openai') {
    if (!creds.refresh_token) { showToast('error', '请输入 Refresh Token'); return false; }
    return true;
  }
  if (platform === 'gemini') {
    if (!creds.refresh_token && !creds.access_token) {
      showToast('error', '请输入 Access Token 或 Refresh Token');
      return false;
    }
    return true;
  }

  return true;
}

function setSubmitting(on) {
  const btn = document.getElementById('btn-submit');
  const text = document.getElementById('btn-submit-text');
  const spinner = document.getElementById('btn-submit-spinner');
  btn.disabled = on;
  text.textContent = on ? '提交中...' : '确认添加';
  spinner.classList.toggle('hidden', !on);
}

// ══════════════════════════════════════
// Delete Account
// ══════════════════════════════════════

async function deleteAccount(id, name) {
  if (!confirm(`确定要删除账号 "${name}" 吗？\n此操作将从 Sub2API 系统中彻底删除该账号。`)) return;

  try {
    const resp = await apiFetch(`/api/accounts/${id}`, {
      method: 'DELETE'
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || err.message || '删除失败');
    }

    showToast('success', '账号已删除');
    await loadAccounts();
  } catch (err) {
    showToast('error', err.message);
  }
}

// ══════════════════════════════════════
// Extension Configuration Modal
// ══════════════════════════════════════

const CONFIG_ENCRYPTION_KEY = CryptoJS.enc.Utf8.parse("sub2api_ext_settings_secret_key_");

function encryptConfig(configObj) {
  const text = JSON.stringify(configObj);
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(text, CONFIG_ENCRYPTION_KEY, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.ciphertext.toString(CryptoJS.enc.Hex);
}

function decryptConfig(payloadString) {
  try {
    const parts = payloadString.split(':');
    const iv = CryptoJS.enc.Hex.parse(parts[0]);
    const encryptedHexStr = CryptoJS.enc.Hex.parse(parts[1]);
    const encryptedBase64Str = CryptoJS.enc.Base64.stringify(encryptedHexStr);

    // Note: CryptoJS.AES.decrypt expects Base64 or CipherParams
    const decrypted = CryptoJS.AES.decrypt(encryptedBase64Str, CONFIG_ENCRYPTION_KEY, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });
    return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
  } catch (e) {
    console.error("Decryption failed", e);
    return {};
  }
}

async function openConfigModal() {
  document.getElementById('config-modal').classList.remove('hidden');
  document.getElementById('btn-save-cfg-text').textContent = '加载中...';
  document.getElementById('btn-save-cfg').disabled = true;

  try {
    const resp = await apiFetch('/api/extension/settings');
    if (resp.ok) {
      const data = await resp.json();
      const config = data.payload ? decryptConfig(data.payload) : {};
      console.log('[Config] 从服务端加载的配置:', JSON.stringify(config, null, 2));

      // ── SUB2API 连接 ──
      const groupInput = document.getElementById('cfg-sub2api-group-name');
      const defaultGroup = currentUser?.email ? String(currentUser.email) : 'codex';
      groupInput.value = config.sub2apiGroupName || defaultGroup;
      groupInput.readOnly = true;
      groupInput.style.backgroundColor = 'var(--bg-secondary, #f5f5f5)';
      groupInput.style.color = 'var(--text-secondary, #888)';
      groupInput.style.cursor = 'not-allowed';
      groupInput.title = '分组名已固定为当前用户邮箱，不可修改';

      // ── 密码 ──
      document.getElementById('cfg-custom-password').value = config.customPassword || '';

      // ── 邮箱 ──
      document.getElementById('cfg-mail-provider').value = config.mailProvider || '163';
      document.getElementById('cfg-email-generator').value = config.emailGenerator || 'duck';
      document.getElementById('cfg-inbucket-host').value = config.inbucketHost || '';
      document.getElementById('cfg-inbucket-mailbox').value = config.inbucketMailbox || '';
      document.getElementById('cfg-cf-domain').value = config.cloudflareDomain || '';

      // ── 自动化行为 ──
      document.getElementById('cfg-autoRunSkipFailures').checked = !!config.autoRunSkipFailures;
      document.getElementById('cfg-skipStep9Enabled').checked = !!config.skipStep9Enabled;
      document.getElementById('cfg-autoRunDelayEnabled').checked = !!config.autoRunDelayEnabled;
      document.getElementById('cfg-autoRunDelayMinutes').value = config.autoRunDelayMinutes || 30;
      document.getElementById('cfg-autoStepRandomDelayMin').value = config.autoStepRandomDelayMinSeconds ?? 0;
      document.getElementById('cfg-autoStepRandomDelayMax').value = config.autoStepRandomDelayMaxSeconds ?? 15;

      // Apply conditional visibility
      onCfgMailProviderChange();
      onCfgEmailGeneratorChange();
    }
  } catch (e) {
    showToast('error', '无法加载配置');
  }

  document.getElementById('btn-save-cfg-text').textContent = '保存配置';
  document.getElementById('btn-save-cfg').disabled = false;
}

function closeConfigModal() {
  document.getElementById('config-modal').classList.add('hidden');
}

// ── Conditional visibility helpers ──

function onCfgPanelModeChange() {
  // 来源已固定为 sub2api，此函数保留以兼容旧代码引用
}

function onCfgMailProviderChange() {
  const provider = document.getElementById('cfg-mail-provider').value;
  
  // Inbucket specific visibility
  document.getElementById('cfg-inbucket-group').classList.toggle('hidden', provider !== 'inbucket');
  
  // Email Generator dropdown visibility (only shown when not using providers that handle their own emails)
  const useHotmail = provider === 'hotmail-api';
  const use2925 = provider === '2925';
  const useEmailGenerator = !useHotmail && !use2925;
  document.getElementById('cfg-email-generator-group').classList.toggle('hidden', !useEmailGenerator);
  
  // Trigger generator change to update CF domain group visibility
  onCfgEmailGeneratorChange();
}

function onCfgEmailGeneratorChange() {
  const provider = document.getElementById('cfg-mail-provider').value;
  const useEmailGenerator = provider !== 'hotmail-api' && provider !== '2925';
  
  const generator = document.getElementById('cfg-email-generator').value;
  const showCloudflareDomain = useEmailGenerator && generator === 'cloudflare';
  
  document.getElementById('cfg-cf-group').classList.toggle('hidden', !showCloudflareDomain);
}

// ── Save ──

async function handleSaveConfig(e) {
  e.preventDefault();

  // 自动获取 Sub2API 地址（从服务端环境变量）
  let autoSub2ApiUrl = '';
  try {
    const urlResp = await apiFetch('/api/sub2api-url');
    if (urlResp.ok) {
      const urlData = await urlResp.json();
      autoSub2ApiUrl = urlData.url || '';
    }
  } catch (e) {
    console.warn('Failed to auto-detect Sub2API URL:', e);
  }

  const config = {
    // 来源固定为 sub2api
    panelMode: 'sub2api',
    // sub2apiUrl 从服务端自动获取；地址/账号/密码均自动处理
    sub2apiUrl: autoSub2ApiUrl,
    sub2apiGroupName: document.getElementById('cfg-sub2api-group-name').value.trim(),

    // 密码
    customPassword: document.getElementById('cfg-custom-password').value,

    // 邮箱
    mailProvider: document.getElementById('cfg-mail-provider').value,
    emailGenerator: document.getElementById('cfg-email-generator').value,
    inbucketHost: document.getElementById('cfg-inbucket-host').value.trim(),
    inbucketMailbox: document.getElementById('cfg-inbucket-mailbox').value.trim(),
    cloudflareDomain: document.getElementById('cfg-cf-domain').value.trim(),

    // 自动化行为
    autoRunSkipFailures: document.getElementById('cfg-autoRunSkipFailures').checked,
    skipStep9Enabled: document.getElementById('cfg-skipStep9Enabled').checked,
    autoRunDelayEnabled: document.getElementById('cfg-autoRunDelayEnabled').checked,
    autoRunDelayMinutes: (val => isNaN(val) ? 30 : val)(parseInt(document.getElementById('cfg-autoRunDelayMinutes').value)),
    autoStepRandomDelayMinSeconds: (val => isNaN(val) ? 12 : val)(parseInt(document.getElementById('cfg-autoStepRandomDelayMin').value)),
    autoStepRandomDelayMaxSeconds: (val => isNaN(val) ? 18 : val)(parseInt(document.getElementById('cfg-autoStepRandomDelayMax').value)),
  };

  console.log('[Config] 保存前的完整配置:', JSON.stringify(config, null, 2));
  const payload = encryptConfig(config);

  const btn = document.getElementById('btn-save-cfg');
  const text = document.getElementById('btn-save-cfg-text');
  const spinner = document.getElementById('btn-save-cfg-spinner');

  btn.disabled = true;
  text.textContent = '保存中...';
  spinner.classList.remove('hidden');

  try {
    const resp = await apiFetch('/api/extension/settings', {
      method: 'POST',
      body: JSON.stringify({ payload })
    });

    if (resp.ok) {
      showToast('success', '配置已保存');
      closeConfigModal();
    } else {
      const err = await resp.json();
      throw new Error(err.error || '保存失败');
    }
  } catch (err) {
    showToast('error', err.message);
  } finally {
    btn.disabled = false;
    text.textContent = '保存配置';
    spinner.classList.add('hidden');
  }
}

// ══════════════════════════════════════
// Pagination
// ══════════════════════════════════════

function goToPage(page) {
  if (page < 1 || page > pagination.pages) return;
  pagination.page = page;
  loadAccounts();
}

function refreshAccounts() {
  pagination.page = 1;
  searchQuery = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  loadAccounts();
  showToast('info', '列表已刷新');
}

// ══════════════════════════════════════
// UI Helpers
// ══════════════════════════════════════

function hideLoading() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('error-message').textContent = msg;
  document.getElementById('error-screen').classList.remove('hidden');
}

function showToast(type, message) {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || ''}</span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function platformLabel(p) {
  const map = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', antigravity: 'Antigravity' };
  return map[p] || p;
}

function typeLabel(t) {
  const map = { oauth: 'OAuth', 'setup-token': 'Setup Token', apikey: 'API Key', upstream: 'Upstream', bedrock: 'Bedrock' };
  return map[t] || t;
}

function statusBadge(s) {
  const map = {
    active: ['badge-status-active', '● 正常'],
    inactive: ['badge-status-inactive', '○ 停用'],
    error: ['badge-status-error', '✕ 异常'],
  };
  const [cls, label] = map[s] || ['badge-type', s];
  return `<span class="badge ${cls}">${label}</span>`;
}

function formatTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return iso; }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ══════════════════════════════════════
// OAuth Authorization Flow
// ══════════════════════════════════════

function resetOAuthState() {
  oauthSessionId = '';
  oauthState = '';
  oauthCredentials = null;
  oauthInputMethod = 'oauth-flow';

  // Reset UI
  const authUrlInput = document.getElementById('oauth-auth-url');
  const authCodeInput = document.getElementById('oauth-auth-code');
  const urlArea = document.getElementById('oauth-url-area');
  const urlDisplay = document.getElementById('oauth-url-display');
  const errorEl = document.getElementById('oauth-error');
  const successEl = document.getElementById('oauth-success');
  const exchangeBtn = document.getElementById('btn-exchange-code');
  const genBtn = document.getElementById('btn-gen-auth-url');

  if (authUrlInput) authUrlInput.value = '';
  if (authCodeInput) authCodeInput.value = '';
  if (urlArea) urlArea.classList.remove('hidden');
  if (urlDisplay) urlDisplay.classList.add('hidden');
  if (errorEl) errorEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (exchangeBtn) exchangeBtn.disabled = true;
  if (genBtn) {
    genBtn.disabled = false;
    document.getElementById('btn-gen-auth-url-text').textContent = '生成授权链接';
  }

  // Reset radio to oauth-flow
  const radio = document.querySelector('input[name="oauth-input-method"][value="oauth-flow"]');
  if (radio) radio.checked = true;
}

function onOAuthMethodChange() {
  const selected = document.querySelector('input[name="oauth-input-method"]:checked');
  oauthInputMethod = selected ? selected.value : 'oauth-flow';

  const flowPanel = document.getElementById('oauth-flow-panel');
  const manualPanel = document.getElementById('manual-key-panel');

  // Hide manual credential fields first
  ['cred-session-key', 'cred-refresh-token', 'cred-gemini-oauth'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });

  if (oauthInputMethod === 'oauth-flow') {
    flowPanel.classList.remove('hidden');
    manualPanel.classList.add('hidden');
  } else {
    flowPanel.classList.add('hidden');
    manualPanel.classList.remove('hidden');
    // Show the appropriate manual key field
    const platform = document.getElementById('form-platform').value;
    const manualFieldId = getManualCredFieldId(platform);
    if (manualFieldId) {
      document.getElementById(manualFieldId).classList.remove('hidden');
    }
  }
}

function getOAuthEndpoints(platform, type) {
  if (platform === 'anthropic') {
    if (type === 'setup-token') {
      return {
        generateUrl: '/api/oauth/accounts/generate-setup-token-url',
        exchangeCode: '/api/oauth/accounts/exchange-setup-token-code',
      };
    }
    return {
      generateUrl: '/api/oauth/accounts/generate-auth-url',
      exchangeCode: '/api/oauth/accounts/exchange-code',
    };
  }
  if (platform === 'openai') {
    return {
      generateUrl: '/api/oauth/openai/generate-auth-url',
      exchangeCode: '/api/oauth/openai/exchange-code',
    };
  }
  if (platform === 'gemini') {
    return {
      generateUrl: '/api/oauth/gemini/auth-url',
      exchangeCode: '/api/oauth/gemini/exchange-code',
    };
  }
  if (platform === 'antigravity') {
    return {
      generateUrl: '/api/oauth/antigravity/auth-url',
      exchangeCode: '/api/oauth/antigravity/exchange-code',
    };
  }
  return null;
}

async function handleGenerateAuthUrl() {
  const platform = document.getElementById('form-platform').value;
  const type = document.getElementById('form-type').value;
  const endpoints = getOAuthEndpoints(platform, type);
  if (!endpoints) {
    showToast('error', '当前平台不支持 OAuth 流程');
    return;
  }

  const btn = document.getElementById('btn-gen-auth-url');
  const btnText = document.getElementById('btn-gen-auth-url-text');
  btn.disabled = true;
  btnText.textContent = '生成中...';

  // Hide previous results
  document.getElementById('oauth-error').classList.add('hidden');
  document.getElementById('oauth-success').classList.add('hidden');
  oauthCredentials = null;

  try {
    const resp = await apiFetch(endpoints.generateUrl, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || err.error || err.message || `生成授权链接失败 (${resp.status})`);
    }

    const rawData = await resp.json();
    // Sub2API wraps responses in { code, message, data: { ... } }
    const data = rawData.data || rawData;
    const authUrl = data.auth_url;
    oauthSessionId = data.session_id || '';
    oauthState = data.state || '';

    if (!authUrl) {
      throw new Error('未返回授权链接');
    }

    // Show the URL
    document.getElementById('oauth-auth-url').value = authUrl;
    document.getElementById('oauth-url-area').classList.add('hidden');
    document.getElementById('oauth-url-display').classList.remove('hidden');

    showToast('success', '授权链接已生成，请复制并在浏览器中打开');
  } catch (err) {
    showOAuthError(err.message);
    showToast('error', err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = '生成授权链接';
  }
}

function copyOAuthUrl() {
  const url = document.getElementById('oauth-auth-url').value;
  if (!url) return;

  navigator.clipboard.writeText(url).then(() => {
    showToast('success', '授权链接已复制到剪贴板');
  }).catch(() => {
    // Fallback for older browsers
    const input = document.getElementById('oauth-auth-url');
    input.select();
    document.execCommand('copy');
    showToast('success', '授权链接已复制到剪贴板');
  });
}

function handleOpenAuthUrl() {
  const url = document.getElementById('oauth-auth-url').value;
  if (!url) return;
  window.open(url, '_blank');
}

function onOAuthCodeInput() {
  const textarea = document.getElementById('oauth-auth-code');
  let value = textarea.value.trim();
  const exchangeBtn = document.getElementById('btn-exchange-code');

  // Auto-extract code from callback URL
  if (value.includes('?') && value.includes('code=')) {
    try {
      const url = new URL(value);
      const code = url.searchParams.get('code');
      const stateParam = url.searchParams.get('state');
      if (stateParam) {
        oauthState = stateParam;
      }
      if (code && code !== value) {
        textarea.value = code;
        value = code;
        showToast('info', '已自动从回调 URL 中提取授权码');
      }
    } catch {
      // Try regex extraction
      const match = value.match(/[?&]code=([^&]+)/);
      const stateMatch = value.match(/[?&]state=([^&]+)/);
      if (stateMatch && stateMatch[1]) {
        oauthState = stateMatch[1];
      }
      if (match && match[1] && match[1] !== value) {
        textarea.value = match[1];
        value = match[1];
        showToast('info', '已自动从回调 URL 中提取授权码');
      }
    }
  }

  exchangeBtn.disabled = !value;
}

async function handleExchangeCode() {
  const platform = document.getElementById('form-platform').value;
  const type = document.getElementById('form-type').value;
  const code = document.getElementById('oauth-auth-code').value.trim();

  if (!code) {
    showToast('error', '请输入授权码');
    return;
  }

  const endpoints = getOAuthEndpoints(platform, type);
  if (!endpoints) {
    showToast('error', '当前平台不支持 OAuth 流程');
    return;
  }

  const btn = document.getElementById('btn-exchange-code');
  const btnText = document.getElementById('btn-exchange-text');
  btn.disabled = true;
  btnText.textContent = '获取中...';

  document.getElementById('oauth-error').classList.add('hidden');

  try {
    const body = {
      session_id: oauthSessionId,
      code: code,
    };
    if (oauthState) body.state = oauthState;

    const resp = await apiFetch(endpoints.exchangeCode, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || err.error || err.message || `交换凭据失败 (${resp.status})`);
    }

    const rawTokenInfo = await resp.json();
    // Sub2API wraps responses in { code, message, data: { ... } }
    const tokenInfo = rawTokenInfo.data || rawTokenInfo;

    // Build credentials based on platform
    oauthCredentials = buildOAuthCredentials(platform, type, tokenInfo);

    // Show success
    const successDetail = buildOAuthSuccessDetail(platform, tokenInfo);
    document.getElementById('oauth-success-detail').textContent = successDetail;
    document.getElementById('oauth-success').classList.remove('hidden');

    showToast('success', '凭据获取成功！可以直接提交添加账号。');
  } catch (err) {
    showOAuthError(err.message);
    showToast('error', err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = '获取凭据';
  }
}

function buildOAuthCredentials(platform, type, tokenInfo) {
  if (platform === 'anthropic') {
    // Claude OAuth returns session_key
    return {
      session_key: tokenInfo.session_key || tokenInfo.sessionKey || tokenInfo.token || '',
    };
  }
  if (platform === 'openai') {
    return {
      refresh_token: tokenInfo.refresh_token || '',
      access_token: tokenInfo.access_token || '',
    };
  }
  if (platform === 'gemini') {
    const creds = {};
    if (tokenInfo.access_token) creds.access_token = tokenInfo.access_token;
    if (tokenInfo.refresh_token) creds.refresh_token = tokenInfo.refresh_token;
    if (tokenInfo.oauth_type) creds.oauth_type = tokenInfo.oauth_type;
    return creds;
  }
  if (platform === 'antigravity') {
    const creds = {};
    if (tokenInfo.access_token) creds.access_token = tokenInfo.access_token;
    if (tokenInfo.refresh_token) creds.refresh_token = tokenInfo.refresh_token;
    if (tokenInfo.token_type) creds.token_type = tokenInfo.token_type;
    if (tokenInfo.expires_at) {
      creds.expires_at = typeof tokenInfo.expires_at === 'number'
        ? Math.floor(tokenInfo.expires_at).toString()
        : String(tokenInfo.expires_at);
    }
    if (tokenInfo.project_id) creds.project_id = tokenInfo.project_id;
    if (tokenInfo.email) creds.email = tokenInfo.email;
    return creds;
  }
  // Fallback: return everything from tokenInfo
  return { ...tokenInfo };
}

function buildOAuthSuccessDetail(platform, tokenInfo) {
  const parts = [];
  if (tokenInfo.email || tokenInfo.email_address) {
    parts.push(`邮箱: ${tokenInfo.email || tokenInfo.email_address}`);
  }
  if (tokenInfo.org_uuid) {
    parts.push(`Org: ${tokenInfo.org_uuid}`);
  }
  if (tokenInfo.account_uuid) {
    parts.push(`Account: ${tokenInfo.account_uuid}`);
  }
  if (tokenInfo.project_id) {
    parts.push(`Project: ${tokenInfo.project_id}`);
  }
  if (parts.length === 0) {
    parts.push('凭据已就绪，请填写其他信息后提交');
  }
  return parts.join(' | ');
}

function showOAuthError(msg) {
  const el = document.getElementById('oauth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

window.openConfigModal = openConfigModal;
window.closeConfigModal = closeConfigModal;
window.handleSaveConfig = handleSaveConfig;
window.onCfgPanelModeChange = onCfgPanelModeChange;
window.onCfgMailProviderChange = onCfgMailProviderChange;
window.onCfgEmailGeneratorChange = onCfgEmailGeneratorChange;

// Exposed functions for user list / accounts
window.openAddModal = openAddModal;
window.closeAddModal = closeAddModal;
window.handleAddAccount = handleAddAccount;
window.onPlatformChange = onPlatformChange;
window.onTypeChange = onTypeChange;
window.deleteAccount = deleteAccount;
window.goToPage = goToPage;

// OAuth flow exposed functions
window.onOAuthMethodChange = onOAuthMethodChange;
window.handleGenerateAuthUrl = handleGenerateAuthUrl;
window.copyOAuthUrl = copyOAuthUrl;
window.handleOpenAuthUrl = handleOpenAuthUrl;
window.onOAuthCodeInput = onOAuthCodeInput;
window.handleExchangeCode = handleExchangeCode;
