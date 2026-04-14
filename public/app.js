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
    document.getElementById('user-badge').textContent = currentUser.username;

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
      user_id: String(currentUser.id),
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
    const displayNotes = (acc.notes || '').replace(/\[added-by:\d+\]\s*/g, '').trim();

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

  container.innerHTML = groups
    .filter(g => g.status === 'active')
    .map(g => `
      <label>
        <input type="checkbox" name="group_ids" value="${g.id}" />
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

  // Show relevant ones
  const credMap = getCredentialField(platform, type);
  if (credMap) {
    document.getElementById(credMap).classList.remove('hidden');
  }
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

  // OAuth / setup-token
  if (platform === 'anthropic' || platform === 'antigravity') return 'cred-session-key';
  if (platform === 'openai') return 'cred-refresh-token';
  if (platform === 'gemini') return 'cred-gemini-oauth';

  return null;
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

  // OAuth / setup-token
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

  // OAuth / setup-token
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
    const resp = await apiFetch(`/api/accounts/${id}?user_id=${currentUser.id}`, {
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
  document.getElementById('cfg-inbucket-group').classList.toggle('hidden', provider !== 'inbucket');
}

function onCfgEmailGeneratorChange() {
  const generator = document.getElementById('cfg-email-generator').value;
  document.getElementById('cfg-cf-group').classList.toggle('hidden', generator !== 'cloudflare');
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
