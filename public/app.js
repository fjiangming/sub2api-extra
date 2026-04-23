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
let proxies = [];
let modelMappingsCount = 0;
let pagination = { page: 1, page_size: 20, total: 0, pages: 1 };
let searchQuery = '';
let searchTimer = null;
let accountTodayStats = {};
let accountUsageInfos = {};
let selectedAccountIds = new Set();  // 跨页保留勾选状态

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
    await Promise.all([loadAccounts(), loadGroups(), loadProxies()]);

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
    
    // Fetch usage stats asynchronously
    fetchUsageData();
  } catch (err) {
    console.error(err);
    showToast('error', err.message);
  }
}

async function fetchUsageData() {
  if (!accounts || accounts.length === 0) return;
  const ids = accounts.map(a => a.id);
  
  // 1. Fetch batch today stats
  try {
    const resp = await apiFetch('/api/accounts/today-stats/batch', {
      method: 'POST',
      body: JSON.stringify({ account_ids: ids })
    });
    if (resp.ok) {
      const data = await resp.json();
      accountTodayStats = data.stats || {};
    }
  } catch (err) {
    console.error('Failed to fetch today stats:', err);
  }

  // Re-render immediately with todayStats
  renderAccounts();

  // 2. Fetch detailed usage：通用判断哪些账号需要拉取 /usage
  //    规则：OAuth / SetupToken 类型，或 Gemini 全类型
  //    这样 Sub2API 未来新增平台（如 mistral oauth）会自动覆盖
  const usageAccs = accounts.filter(a => {
    if (a.type === 'oauth' || a.type === 'setup-token') return true;
    if (a.platform === 'gemini') return true;
    return false;
  });
  for (const acc of usageAccs) {
    try {
      // Original system passes source='passive' for anthropic oauth/setup-token
      const isAnthropicOAuth = acc.platform === 'anthropic' && (acc.type === 'oauth' || acc.type === 'setup-token');
      const sourceParam = isAnthropicOAuth ? '?source=passive' : '';
      const resp = await apiFetch(`/api/accounts/${acc.id}/usage${sourceParam}`);
      if (resp.ok) {
        accountUsageInfos[acc.id] = await resp.json();
        // Update just the usage cell instead of full re-render
        const tr = document.getElementById(`acc-row-${acc.id}`);
        if (tr) {
          const usageTd = tr.querySelector('.cell-usage');
          if (usageTd) usageTd.innerHTML = renderUsageCell(acc);
        }
      }
    } catch (e) {
      console.error(`Failed to fetch usage for ${acc.id}:`, e);
    }
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

async function loadProxies() {
  try {
    // Sub2API proxy API is at /admin/proxies/all, proxy passed via sub2api /api layer
    const resp = await apiFetch('/api/admin/proxies/all');
    if (!resp.ok) return;
    
    proxies = await resp.json();
    renderProxyOptions();
  } catch (err) {
    console.error('Failed to load proxies:', err);
  }
}

function renderProxyOptions() {
  const sel = document.getElementById('form-proxy-id');
  if (!sel) return;
  const currentVal = sel.value;
  let html = '<option value="">直连 (未分配代理)</option>';
  proxies.forEach(p => {
    const label = `${p.protocol || 'http'}://${p.host}:${p.port}`;
    html += `<option value="${p.id}">${label}</option>`;
  });
  sel.innerHTML = html;
  if (currentVal && proxies.some(p => String(p.id) === String(currentVal))) {
    sel.value = currentVal;
  }
}

// ══════════════════════════════════════
// Rendering
// ══════════════════════════════════════

function formatCompactNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
  return num.toString();
}

function renderProgressBar(label, utilization, colorStr) {
  if (utilization === null || utilization === undefined) return '';
  const percent = Math.min(100, Math.max(0, utilization * 100));
  return `
    <div style="margin-bottom: 3px;">
      <div style="font-size: 9px; display: flex; justify-content: space-between; color: #666; margin-bottom: 1px;">
        <span>${label}</span>
        <span>${percent.toFixed(1)}%</span>
      </div>
      <div style="width: 100%; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden;">
        <div style="width: ${percent}%; height: 100%; background: ${colorStr}; border-radius: 2px; transition: width 0.3s ease;"></div>
      </div>
    </div>
  `;
}

function renderUsageCell(acc) {
  let html = '';
  const stats = accountTodayStats[String(acc.id)];
  const usage = accountUsageInfos[acc.id];

  // ── Branch 1: Anthropic OAuth / Setup-Token ──
  if (acc.platform === 'anthropic' && (acc.type === 'oauth' || acc.type === 'setup-token')) {
    if (usage) {
      if (usage.error) {
        html += `<div style="font-size:10px;color:#d97706;" title="${escapeHtml(usage.error)}">${escapeHtml(usage.error)}</div>`;
      }
      if (usage.five_hour) html += renderProgressBar('5h', usage.five_hour.utilization, '#6366f1');
      if (usage.seven_day) html += renderProgressBar('7d', usage.seven_day.utilization, '#10b981');
      if (usage.seven_day_sonnet) html += renderProgressBar('7d S', usage.seven_day_sonnet.utilization, '#8b5cf6');
      // 通用：自动发现后端未来新增的窗口字段
      html += renderAutoDiscoveredWindows(usage, ['five_hour', 'seven_day', 'seven_day_sonnet']);
      if (!html.trim()) html += `<span style="font-size:10px;color:#999">-</span>`;
    } else {
      html += `<div style="font-size:10px;color:#999;">加载中...</div>`;
    }

  // ── Branch 2: OpenAI OAuth ──
  } else if (acc.platform === 'openai' && acc.type === 'oauth') {
    if (usage) {
      if (usage.five_hour) html += renderProgressBar('5h', usage.five_hour.utilization, '#6366f1');
      if (usage.seven_day) html += renderProgressBar('7d', usage.seven_day.utilization, '#10b981');
      html += renderAutoDiscoveredWindows(usage, ['five_hour', 'seven_day']);
      if (!html.trim()) html += `<span style="font-size:10px;color:#999">-</span>`;
    } else {
      html += `<div style="font-size:10px;color:#999;">加载中...</div>`;
    }

  // ── Branch 3: Antigravity OAuth ──
  } else if (acc.platform === 'antigravity' && acc.type === 'oauth') {
    if (usage) {
      if (usage.is_forbidden) {
        const fType = usage.forbidden_type || 'forbidden';
        const fLabel = fType === 'validation' ? '需要验证' : fType === 'violation' ? '违规封禁' : '已禁止';
        const fColor = fType === 'validation' ? '#ca8a04' : '#dc2626';
        html += `<span style="font-size:10px;color:${fColor};">${fLabel}</span>`;
      } else if (usage.needs_reauth) {
        html += `<span style="font-size:10px;color:#ea580c;">需要重新授权</span>`;
      } else if (usage.error) {
        html += `<span style="font-size:10px;color:#d97706;">${usage.error_code === 'rate_limited' ? '被限频' : '用量异常'}</span>`;
      } else if (usage.antigravity_quota && Object.keys(usage.antigravity_quota).length > 0) {
        // 通用渲染：自动遍历所有模型，无需硬编码模型名
        html += renderAntigravityQuotaGeneric(usage.antigravity_quota);
      }
      if (usage.ai_credits && Array.isArray(usage.ai_credits)) {
        const total = usage.ai_credits.reduce((sum, c) => sum + (c.amount || 0), 0);
        if (total > 0) html += `<div style="font-size:10px;color:#666;margin-top:2px;">💳 余额: ${total.toFixed(0)}</div>`;
      }
      if (!html) html = `<span style="font-size:10px;color:#999">-</span>`;
    } else {
      html += `<div style="font-size:10px;color:#999;">加载中...</div>`;
    }

  // ── Branch 4: Gemini (all types) ──
  } else if (acc.platform === 'gemini') {
    if (usage) {
      let hasGeminiBars = false;
      // 通用：自动发现所有 gemini_* 窗口字段
      const geminiKeys = Object.keys(usage).filter(k => k.startsWith('gemini_') && typeof usage[k] === 'object' && usage[k] !== null && 'utilization' in usage[k]);
      const sharedKeys = geminiKeys.filter(k => k.includes('shared'));
      const modelKeys = geminiKeys.filter(k => !k.includes('shared'));
      const keysToRender = sharedKeys.length > 0 ? sharedKeys : modelKeys;
      for (const key of keysToRender) {
        const label = key.replace('gemini_', '').replace('_daily', '/d').replace('_minute', '/m').replace('_', ' ');
        const color = key.includes('flash') ? '#10b981' : '#6366f1';
        html += renderProgressBar(label, usage[key].utilization, color);
        hasGeminiBars = true;
      }
      if (hasGeminiBars) html += `<div style="font-size:8px;color:#999;margin-top:1px;font-style:italic;">* 模拟配额</div>`;
      if (!hasGeminiBars) html += `<span style="font-size:10px;color:#999">无限制</span>`;
    } else {
      html += `<div style="font-size:10px;color:#999;">加载中...</div>`;
    }

  // ── Branch 5: 通用兜底（含未来新增平台的 OAuth 账号） ──
  } else {
    if (usage) {
      html += renderAutoDiscoveredWindows(usage, []);
    }
    if (!html.trim() && stats) {
      html += `<div style="display:flex; gap: 4px; font-size: 9px; color: #666; flex-wrap: wrap;">
        <span style="background: #f3f4f6; padding: 1px 4px; border-radius: 3px;">${formatCompactNumber(stats.requests)} req</span>
        <span style="background: #f3f4f6; padding: 1px 4px; border-radius: 3px;">${formatCompactNumber(stats.tokens)}</span>
        <span style="background: #f3f4f6; padding: 1px 4px; border-radius: 3px;">$${Number(stats.cost || 0).toFixed(4)}</span>
      </div>`;
    }
    if (!html.trim()) html += `<span style="font-size:10px;color:#999">-</span>`;
  }
  return html || '<span style="font-size:10px;color:#999">-</span>';
}

// ── 通用工具函数（减少未来维护成本） ──

// 已知的非窗口字段，自动发现时跳过
const USAGE_META_KEYS = new Set([
  'error', 'error_code', 'source', 'is_forbidden', 'forbidden_type',
  'needs_reauth', 'validation_url', 'antigravity_quota', 'ai_credits'
]);

/**
 * 自动发现 usage 响应中所有带 utilization 的窗口对象并渲染。
 * 这样 Sub2API 未来新增任何窗口类型（如 one_hour, thirty_day 等）都会自动展示。
 */
function renderAutoDiscoveredWindows(usage, excludeKeys) {
  let html = '';
  const excluded = new Set([...excludeKeys, ...USAGE_META_KEYS]);
  const colors = ['#6366f1', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6'];
  let colorIdx = 0;
  for (const [key, val] of Object.entries(usage)) {
    if (excluded.has(key)) continue;
    if (key.startsWith('gemini_')) continue; // gemini 字段由 Branch 4 处理
    if (val && typeof val === 'object' && 'utilization' in val) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        .replace('Five Hour', '5h').replace('Seven Day', '7d')
        .replace('Thirty Day', '30d').replace('One Hour', '1h');
      html += renderProgressBar(label, val.utilization, colors[colorIdx % colors.length]);
      colorIdx++;
    }
  }
  return html;
}

/**
 * 通用渲染 antigravity_quota：自动按模型族分组，无需硬编码模型名。
 * Sub2API 新增模型会自动出现。
 */
function renderAntigravityQuotaGeneric(quota) {
  let html = '';
  const groups = {};
  for (const [model, data] of Object.entries(quota)) {
    if (!data || typeof data !== 'object' || !('utilization' in data)) continue;
    const label = modelToLabel(model);
    if (!groups[label]) groups[label] = { maxUtil: 0 };
    if (data.utilization > groups[label].maxUtil) groups[label].maxUtil = data.utilization;
  }
  const colors = ['#6366f1', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6'];
  let i = 0;
  for (const [label, info] of Object.entries(groups)) {
    html += renderProgressBar(label, info.maxUtil, colors[i % colors.length]);
    i++;
  }
  return html;
}

/**
 * 将模型全名转为简短显示标签。已知前缀友好命名，未知模型自动截断。
 */
function modelToLabel(model) {
  if (model.match(/^gemini-3-pro/)) return 'G3 Pro';
  if (model.match(/^gemini-3-flash/)) return 'G3 Flash';
  if (model.match(/^gemini-.*image/)) return 'Image';
  if (model.match(/^gemini-2/)) return 'G2';
  if (model.match(/^claude-opus/)) return 'Claude Opus';
  if (model.match(/^claude-sonnet/)) return 'Claude Sonnet';
  if (model.match(/^claude/)) return 'Claude';
  // 兜底：取前两段
  const parts = model.split('-');
  return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function renderAccounts() {
  const tbody = document.getElementById('accounts-tbody');

  if (accounts.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="9">
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <p>${searchQuery ? '没有找到匹配的账号' : '暂无账号'}</p>
            <p class="empty-sub">${searchQuery ? '尝试其他搜索词' : '点击"添加账号"开始'}</p>
          </div>
        </td>
      </tr>`;
    updateSelectAllCheckbox();
    updateExportButton();
    return;
  }

  tbody.innerHTML = accounts.map(acc => {
    // Clean up notes for display (remove ownership tag)
    const displayNotes = (acc.notes || '').trim();
    const isChecked = selectedAccountIds.has(acc.id) ? 'checked' : '';

    return `
      <tr id="acc-row-${acc.id}">
        <td class="cell-checkbox"><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isChecked} onchange="toggleSelectAccount(${acc.id}, this.checked)" /></td>
        <td class="cell-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</td>
        <td><span class="badge badge-platform">${platformLabel(acc.platform)}</span></td>
        <td><span class="badge badge-type">${typeLabel(acc.type)}</span></td>
        <td>${statusBadge(acc.status)}</td>
        <td class="cell-usage" style="width: 140px; vertical-align: middle;">${renderUsageCell(acc)}</td>
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

  updateSelectAllCheckbox();
  updateExportButton();
}

function renderPagination() {
  const container = document.getElementById('pagination');

  if (pagination.total === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  if (!pagination.pages || pagination.pages < 1) pagination.pages = 1;

  const total = pagination.total;
  const page = pagination.page;
  const size = pagination.page_size;
  const totalPages = pagination.pages;

  const fromItem = total === 0 ? 0 : (page - 1) * size + 1;
  const toItem = Math.min(page * size, total);

  let html = `
    <div class="pagination-info">
      <span>显示 <span class="font-medium">${fromItem}</span> 到 <span class="font-medium">${toItem}</span> 共 <span class="font-medium">${total}</span> 条结果</span>
      <div class="page-size-selector">
        <span>每页显示:</span>
        <select onchange="changePageSize(this)">
          ${[10, 20, 50, 100].map(s => `<option value="${s}" ${s === size ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    
    <div style="display:flex; gap:12px; align-items:center;">
      <div class="pagination-jump">
        <span>跳转到:</span>
        <input type="number" min="1" max="${totalPages}" class="jump-input" id="jump-page-input" placeholder="页码" onkeypress="if(event.key === 'Enter') jumpToPage(this.value)">
        <button class="btn btn-sm btn-secondary" onclick="jumpToPage(document.getElementById('jump-page-input').value)">Go</button>
      </div>
      <nav class="pagination-nav">
  `;

  // Previous
  html += `<button class="nav-btn ${page <= 1 ? 'disabled' : ''}" ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="15 18 9 12 15 6"></polyline></svg>
  </button>`;

  // Page numbers
  const maxVisible = 5;
  let start = Math.max(1, page - Math.floor(maxVisible / 2));
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

  if (start > 1) {
    html += `<button class="nav-btn" onclick="goToPage(1)">1</button>`;
    if (start > 2) html += `<button class="nav-btn disabled" disabled>…</button>`;
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="nav-btn ${i === page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (end < totalPages) {
    if (end < totalPages - 1) html += `<button class="nav-btn disabled" disabled>…</button>`;
    html += `<button class="nav-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }

  // Next
  html += `<button class="nav-btn ${page >= totalPages ? 'disabled' : ''}" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9 18 15 12 9 6"></polyline></svg>
  </button>`;

  html += `</nav></div>`;

  container.innerHTML = html;
}

function changePageSize(select) {
  const newSize = parseInt(select.value, 10);
  if (!isNaN(newSize) && newSize > 0) {
    pagination.page_size = newSize;
    pagination.page = 1;
    loadAccounts();
  }
}

function jumpToPage(val) {
  let p = parseInt(val, 10);
  if (!isNaN(p)) {
    p = Math.max(1, Math.min(p, pagination.pages));
    goToPage(p);
  }
}

function renderGroupsCheckboxes() {
  const container = document.getElementById('form-groups-container') || document.getElementById('groups-container');
  if (!container) return;
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

  // Reset advanced fields
  document.getElementById('form-concurrency').value = '10';
  document.getElementById('form-rate-multiplier').value = '1';
  document.getElementById('form-priority').value = '1';
  document.getElementById('form-pool-retry').value = '3';
  // Reset model whitelist selector state
  _mwsSelectedModels = [];
  window.setModelMode('whitelist');
  
  const mappingsContainer = document.getElementById('mappings-container');
  if (mappingsContainer) mappingsContainer.innerHTML = '';
  modelMappingsCount = 0;

  // Reset to default platform
  document.getElementById('form-platform').value = 'anthropic';
  document.getElementById('form-type').value = 'oauth';

  // Initialize segmented control
  selectPlatform('anthropic');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

// ── Platform Segmented Control ──

function selectPlatform(platform) {
  // Update hidden input
  document.getElementById('form-platform').value = platform;

  // Update segmented control visual
  document.querySelectorAll('.platform-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === platform);
  });

  // Render type cards for the selected platform
  renderTypeCards(platform);
}

// ── Type Card Rendering ──

function renderTypeCards(platform) {
  const container = document.getElementById('type-cards');
  const types = getTypesForPlatform(platform);

  // Card color mapping per platform
  const platformColor = {
    anthropic: 'card-orange',
    openai: 'card-green',
    gemini: 'card-blue',
    antigravity: 'card-purple',
  };

  // Icon SVGs for each type
  const typeIcons = {
    oauth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>',
    'setup-token': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>',
    apikey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>',
    upstream: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/></svg>',
    bedrock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"/></svg>',
  };

  // Description mapping
  const typeDescs = {
    oauth: {
      anthropic: 'OAuth 授权登录获取 Session Key',
      openai: 'OAuth 授权获取 Refresh Token',
      gemini: 'Google OAuth 授权登录',
      antigravity: 'OAuth 授权获取 Session Key',
    },
    'setup-token': { anthropic: '通过 Setup Token 授权' },
    apikey: {
      anthropic: 'API Console 生成的密钥',
      openai: 'OpenAI API 密钥',
      gemini: 'AI Studio API 密钥',
      antigravity: 'Antigravity API 密钥',
    },
    upstream: {
      anthropic: '中继到其他兼容服务',
      openai: '中继到其他兼容服务',
      gemini: '中继到其他兼容服务',
      antigravity: '中继到其他兼容服务',
    },
    bedrock: { antigravity: 'AWS Bedrock 云服务凭据' },
  };

  const colorClass = platformColor[platform] || 'card-purple';

  container.innerHTML = types.map((t, idx) => {
    const icon = typeIcons[t.value] || typeIcons.apikey;
    const desc = (typeDescs[t.value] || {})[platform] || t.label;
    return `
      <button type="button" class="type-card ${colorClass} ${idx === 0 ? 'active' : ''}" data-type="${t.value}" onclick="selectType('${t.value}')">
        <div class="type-card-icon">${icon}</div>
        <div class="type-card-info">
          <span class="type-card-title">${t.label}</span>
          <span class="type-card-desc">${desc}</span>
        </div>
      </button>
    `;
  }).join('');

  // Auto-select the first type
  if (types.length > 0) {
    selectType(types[0].value);
  }
}

// ── Type Selection ──

function selectType(type) {
  // Update hidden input
  document.getElementById('form-type').value = type;

  // Update card visuals
  document.querySelectorAll('.type-card').forEach(card => {
    card.classList.toggle('active', card.dataset.type === type);
  });

  // Update step indicator
  const stepIndicator = document.getElementById('step-indicator');
  if (isOAuthType(type)) {
    stepIndicator.classList.remove('hidden');
    document.getElementById('step-num-1').classList.add('active');
    document.getElementById('step-num-2').classList.add('active');
    document.getElementById('step-label-2').textContent = type === 'setup-token' ? 'Setup Token 授权' : 'OAuth 授权';
  } else {
    stepIndicator.classList.add('hidden');
  }

  // Trigger credential field visibility
  onTypeChange();
}

// Platform / Type change → show relevant credential fields (internal)
function onPlatformChange() {
  const platform = document.getElementById('form-platform').value;
  selectPlatform(platform);
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

  // Update Advanced Configuration Toggles
  updateAdvancedToggles(platform, type);
}

function updateAdvancedToggles(platform, type) {
  ['openai-opts', 'anthropic-opts', 'antigravity-opts', 'bedrock-presets'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  
  const optsContainer = document.getElementById('platform-options');
  if (optsContainer) optsContainer.classList.remove('hidden');
  
  // Custom Error Codes
  const errContainer = document.getElementById('custom-error-codes-section');
  if (errContainer) errContainer.classList.remove('hidden');

  // Intercept Warmup: only for anthropic / antigravity (matches reference)
  const interceptContainer = document.getElementById('intercept-warmup-section');
  if (interceptContainer) {
    if (platform === 'anthropic' || platform === 'antigravity') {
      interceptContainer.classList.remove('hidden');
    } else {
      interceptContainer.classList.add('hidden');
    }
  }

  // Quota Control is ONLY for Anthropic OAuth
  const qcContainer = document.getElementById('quota-control-section');
  if (qcContainer) {
    if (platform === 'anthropic' && isOAuthType(type)) {
      qcContainer.classList.remove('hidden');
    } else {
      qcContainer.classList.add('hidden');
    }
  }
  
  if (platform === 'openai') {
    document.getElementById('openai-opts').classList.remove('hidden');
    const codexOpt = document.getElementById('openai-codex-opt');
    if (codexOpt) {
      codexOpt.style.display = isOAuthType(type) ? 'block' : 'none';
    }
  } else if (platform === 'anthropic') {
    document.getElementById('anthropic-opts').classList.remove('hidden');
  } else if (platform === 'antigravity') {
    document.getElementById('antigravity-opts').classList.remove('hidden');
  }

  // Re-render model chips/preset mappings for the new platform
  const wlArea = document.getElementById('whitelist-area');
  if (wlArea && !wlArea.classList.contains('hidden')) {
    // Auto-fill related models on platform change (matches sub2api behavior)
    mwsAutoFillForPlatform();
    renderModelChips();
  } else {
    renderPresetMappings();
  }
}

// onModelModeChange is now handled by window.setModelMode

function addModelMapping(fromModel = '', toModel = '') {
  const container = document.getElementById('mappings-container');
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.gap = '8px';
  div.style.alignItems = 'center';
  
  div.innerHTML = `
    <input type="text" class="mapping-from" placeholder="前端请求的模型" value="${escapeHtml(fromModel)}" style="flex:1" />
    <span style="color:#94a3b8">→</span>
    <input type="text" class="mapping-to" placeholder="实际转发的模型" value="${escapeHtml(toModel)}" style="flex:1" />
    <button type="button" class="btn btn-danger btn-sm js-del-mapping" style="padding:4px 8px;">删</button>
  `;
  div.querySelector('.js-del-mapping').addEventListener('click', () => div.remove());
  container.appendChild(div);
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
  if (platform === 'bedrock' || type === 'bedrock') {
    const authMode = document.getElementById('form-bedrock-auth-mode').value;
    if (authMode === 'sigv4') {
      return {
        access_key_id: document.getElementById('form-bedrock-access-key').value.trim(),
        secret_access_key: document.getElementById('form-bedrock-secret-key').value.trim(),
        session_token: document.getElementById('form-bedrock-session-token').value.trim() || undefined,
        region: document.getElementById('form-bedrock-region').value.trim(),
        force_global_endpoint: document.getElementById('form-bedrock-force-use-global').checked
      };
    } else {
      return {
        api_key: document.getElementById('form-bedrock-api-key-only').value.trim(),
        region: document.getElementById('form-bedrock-region').value.trim(),
        force_global_endpoint: document.getElementById('form-bedrock-force-use-global').checked
      };
    }
  }

  // Anthropic / OpenAI / Gemini handle...
  if (oauthInputMethod === 'oauth-flow' && isOAuthType(type)) {
    return oauthCredentials;
  }
  const t = getManualCredFieldId(platform);
  if (t === 'cred-session-key') return { session_key: document.getElementById('form-session-key').value.trim() };
  if (t === 'cred-api-key') return { api_key: document.getElementById('form-api-key').value.trim() };
  if (t === 'cred-refresh-token') return { refresh_token: document.getElementById('form-refresh-token').value.trim() };
  if (t === 'cred-gemini-oauth') {
    return {
      access_token: document.getElementById('form-gemini-access-token').value.trim() || undefined,
      refresh_token: document.getElementById('form-gemini-refresh-token').value.trim(),
      oauth_type: document.getElementById('form-gemini-oauth-type').value || undefined
    };
  }
  if (t === 'cred-upstream') {
    return {
      base_url: document.getElementById('form-upstream-url').value.trim(),
      api_key: document.getElementById('form-upstream-key').value.trim() || undefined
    };
  }
  return null;
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

  // Build Extra Configurations
  const extra = {};
  
  const poolMode = document.getElementById('form-pool-mode').checked;
  const poolRetry = parseInt(document.getElementById('form-pool-retry').value);
  if (poolMode) {
    credentials.pool_mode = true;
    credentials.pool_mode_retry_count = isNaN(poolRetry) ? 3 : poolRetry;
  }
  
  // These are top-level fields on CreateAccountRequest, not part of extra
  const concurrency = parseInt(document.getElementById('form-concurrency').value);
  const priority = parseInt(document.getElementById('form-priority').value);
  const rateMultiplier = parseFloat(document.getElementById('form-rate-multiplier').value);
  const autoPause = document.getElementById('form-auto-pause').checked;
  
  const interceptWarmup = toggleStates['intercept-warmup'];
  if (interceptWarmup) credentials.intercept_warmup_requests = true;

  const expStr = document.getElementById('form-expires-at').value;
  
  // Custom Error Codes
  try {
    const errorCodesTags = JSON.parse(document.getElementById('form-custom-error-codes').value || '[]');
    if (errorCodesTags.length > 0) {
      credentials.custom_error_codes_enabled = true;
      credentials.custom_error_codes = errorCodesTags;
    }
  } catch(e){}

  // Temp unschedulable rules
  try {
    const tempRules = JSON.parse(document.getElementById('form-temp-rules').value || '[]');
    if (tempRules.length > 0) {
      credentials.temp_unschedulable_enabled = true;
      credentials.temp_unschedulable_rules = tempRules.map(r => ({
        status_code: parseInt(r.code),
        duration: parseInt(r.duration),
        keywords: r.keywords
      }));
    }
  } catch(e){}

  // Quota Control — flatten directly into extra (matching backend field names)
  if (platform === 'anthropic' && isOAuthType(type)) {
    applyQuotaControlToExtra(extra);
  }
  
  if (platform === 'openai') {
    if (document.getElementById('form-openai-passthrough').checked) extra.openai_passthrough = true;
    const wsMode = document.getElementById('form-ws-mode').value;
    if (wsMode !== 'off') {
      if (isOAuthType(type)) {
        extra.openai_oauth_responses_websockets_v2_mode = wsMode;
        extra.openai_oauth_responses_websockets_v2_enabled = true;
      } else {
        extra.openai_apikey_responses_websockets_v2_mode = wsMode;
        extra.openai_apikey_responses_websockets_v2_enabled = true;
      }
    }
    if (isOAuthType(type) && document.getElementById('form-codex-cli')?.checked) {
      extra.codex_cli_only = true;
    }
  } else if (platform === 'anthropic') {
    if (document.getElementById('form-anthropic-passthrough').checked) extra.anthropic_passthrough = true;
  } else if (platform === 'antigravity') {
    if (document.getElementById('form-mixed-scheduling').checked) extra.mixed_scheduling = true;
    if (document.getElementById('form-allow-overages').checked) extra.allow_overages = true;
  }
  
  const totalQuota = parseFloat(document.getElementById('form-quota-total')?.value);
  const dailyQuota = parseFloat(document.getElementById('form-quota-daily')?.value);
  const weeklyQuota = parseFloat(document.getElementById('form-quota-weekly')?.value);
  
  if (!isNaN(totalQuota) || !isNaN(dailyQuota) || !isNaN(weeklyQuota)) {
    if (!isNaN(totalQuota) && totalQuota > 0) extra.quota_limit = totalQuota;
    if (!isNaN(dailyQuota) && dailyQuota > 0) {
      extra.quota_daily_limit = dailyQuota;
      extra.quota_daily_reset_mode = 'fixed';
      extra.quota_daily_reset_hour = parseInt(document.getElementById('form-quota-daily-hr')?.value) || 0;
    }
    if (!isNaN(weeklyQuota) && weeklyQuota > 0) {
      extra.quota_weekly_limit = weeklyQuota;
      extra.quota_weekly_reset_mode = 'fixed';
      extra.quota_weekly_reset_hour = parseInt(document.getElementById('form-quota-weekly-hr')?.value) || 0;
      extra.quota_weekly_reset_day = parseInt(document.getElementById('form-quota-weekly-day')?.value) || 1;
    }
    if (!isNaN(dailyQuota) || !isNaN(weeklyQuota)) {
      const tz = document.getElementById('form-quota-tz')?.value?.trim();
      if (tz) extra.quota_reset_timezone = tz;
    }
  }
  
  // Model Restrictions
  const whitelistArea = document.getElementById('whitelist-area');
  const allowWhitelist = !whitelistArea.classList.contains('hidden');

  if (allowWhitelist) {
    if (_mwsSelectedModels && _mwsSelectedModels.length > 0) {
      extra.model_whitelist = [..._mwsSelectedModels];
    }
  } else {
    const mapping = {};
    document.querySelectorAll('#mappings-container div').forEach(div => {
      const from = div.querySelector('.mapping-from').value.trim();
      const to = div.querySelector('.mapping-to').value.trim();
      if (from && to) mapping[from] = to;
    });
    if (Object.keys(mapping).length > 0) credentials.model_mapping = mapping;
  }
  
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

  // Top-level account fields (not in extra)
  if (!isNaN(concurrency) && concurrency > 0) body.concurrency = concurrency;
  if (!isNaN(priority)) body.priority = priority;
  if (!isNaN(rateMultiplier) && rateMultiplier > 0) body.rate_multiplier = rateMultiplier;
  if (!autoPause) body.auto_pause_on_expired = false;
  if (expStr) body.expires_at = Math.floor(new Date(expStr).getTime() / 1000);
  
  const proxyId = document.getElementById('form-proxy-id').value;
  if (proxyId) body.proxy_id = parseInt(proxyId);
  
  if (Object.keys(extra).length > 0) body.extra = extra;
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


// --- Specific logic for Quota Control Toggles ---
let toggleStates = {
  'window-cost': false,
  'session-limit': false,
  'rpm-limit': false,
  'tls': false,
  'session-mask': false,
  'cache-ttl': false,
  'custom-url': false,
  'intercept-warmup': false,
  'custom-error-codes': false,
  'temp-rules': false
};

function initToggles() {
  const toggleIds = Object.keys(toggleStates);
  toggleIds.forEach(id => {
    const el = document.getElementById('toggle-' + id);
    if (!el) return;
    el.addEventListener('click', () => {
      toggleStates[id] = !toggleStates[id];
      renderToggle(id);
    });
  });
}

function renderToggle(id) {
  const el = document.getElementById('toggle-' + id);
  if (!el) return;
  const nob = el.querySelector('.toggle-nob');
  const spanTargetId = id === 'temp-rules' ? 'temp-rules-container-wrapper' : id + '-area';
  const targetArea = document.getElementById(spanTargetId);
  
  if (toggleStates[id]) {
    el.classList.remove('bg-gray-200');
    el.classList.add('bg-primary-600');
    nob.classList.remove('translate-x-0');
    nob.classList.add('translate-x-5');
    if (targetArea) targetArea.classList.remove('hidden');
  } else {
    el.classList.add('bg-gray-200');
    el.classList.remove('bg-primary-600');
    nob.classList.add('translate-x-0');
    nob.classList.remove('translate-x-5');
    if (targetArea) targetArea.classList.add('hidden');
  }
}

function setRpmStrategy(strategy) {
  document.getElementById('v-rpm-strategy').value = strategy;
  document.getElementById('rpm-str-tiered').classList.toggle('active', strategy === 'tiered');
  document.getElementById('rpm-str-sticky').classList.toggle('active', strategy === 'sticky_exempt');
  if (strategy === 'tiered') {
    document.getElementById('rpm-strategy-buffer-area').classList.remove('hidden');
  } else {
    document.getElementById('rpm-strategy-buffer-area').classList.add('hidden');
  }
}

function setUmqMode(mode) {
  document.getElementById('v-user-msg-queue').value = mode;
  ['off', 'throttle', 'serialize'].forEach(id => {
    document.getElementById('umq-' + id).classList.remove('active');
  });
  const idMap = { '':'off', 'throttle':'throttle', 'serialize':'serialize' };
  if (idMap[mode] !== undefined) document.getElementById('umq-' + idMap[mode]).classList.add('active');
}

// Add initToggles to initialization
document.addEventListener('DOMContentLoaded', () => {
  initToggles();

  // Model mode tab buttons
  const wlBtn = document.getElementById('btn-mode-whitelist');
  const mpBtn = document.getElementById('btn-mode-mapping');
  if (wlBtn) wlBtn.addEventListener('click', () => window.setModelMode('whitelist'));
  if (mpBtn) mpBtn.addEventListener('click', () => window.setModelMode('mapping'));

  // Add mapping button
  const addMappingBtn = document.getElementById('btn-add-mapping');
  if (addMappingBtn) addMappingBtn.addEventListener('click', () => addModelMapping());

  // Model Whitelist Selector bindings
  const mwsTrigger = document.getElementById('mws-trigger');
  if (mwsTrigger) mwsTrigger.addEventListener('click', () => mwsToggleDropdown());

  const mwsSearch = document.getElementById('mws-search');
  if (mwsSearch) {
    mwsSearch.addEventListener('click', (e) => e.stopPropagation());
    mwsSearch.addEventListener('input', (e) => mwsRenderOptions(e.target.value));
  }

  const mwsFillBtn = document.getElementById('mws-fill-related');
  if (mwsFillBtn) mwsFillBtn.addEventListener('click', () => mwsFillRelated());

  const mwsClearBtn = document.getElementById('mws-clear-all');
  if (mwsClearBtn) mwsClearBtn.addEventListener('click', () => mwsClearAll());

  const mwsAddBtn = document.getElementById('mws-add-custom');
  if (mwsAddBtn) mwsAddBtn.addEventListener('click', () => mwsAddCustom());

  const mwsCustomInput = document.getElementById('mws-custom-input');
  if (mwsCustomInput) mwsCustomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mwsAddCustom(); } });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const container = document.querySelector('.mws-container');
    if (container && !container.contains(e.target) && _mwsDropdownOpen) {
      _mwsDropdownOpen = false;
      const dd = document.getElementById('mws-dropdown');
      if (dd) dd.classList.add('hidden');
    }
  });

  // Render initial model chips after a small delay (form-platform is set)
  setTimeout(() => {
    renderModelChips();
  }, 100);
});

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
      document.getElementById('cfg-mail-provider').value = config.mailProvider || '2925';
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
// Account Selection & CPA Export
// ══════════════════════════════════════

function toggleSelectAccount(id, checked) {
  if (checked) {
    selectedAccountIds.add(id);
  } else {
    selectedAccountIds.delete(id);
  }
  updateSelectAllCheckbox();
  updateExportButton();
}

function toggleSelectAll(checked) {
  // 只影响当前页的账号
  accounts.forEach(acc => {
    if (checked) {
      selectedAccountIds.add(acc.id);
    } else {
      selectedAccountIds.delete(acc.id);
    }
  });
  // 更新所有行内的 checkbox
  document.querySelectorAll('.row-checkbox').forEach(cb => {
    cb.checked = checked;
  });
  updateExportButton();
}

function updateSelectAllCheckbox() {
  const selectAllCb = document.getElementById('select-all-checkbox');
  if (!selectAllCb) return;
  if (accounts.length === 0) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
    return;
  }
  const allChecked = accounts.every(acc => selectedAccountIds.has(acc.id));
  const someChecked = accounts.some(acc => selectedAccountIds.has(acc.id));
  selectAllCb.checked = allChecked;
  selectAllCb.indeterminate = someChecked && !allChecked;
}

function updateExportButton() {
  const btnText = document.getElementById('export-btn-text');
  if (!btnText) return;
  const count = selectedAccountIds.size;
  btnText.textContent = count > 0 ? `导出 CPA (${count})` : '导出 CPA';
}

async function exportSelectedToCPA() {
  const ids = Array.from(selectedAccountIds);
  if (ids.length === 0) {
    showToast('warning', '请先勾选需要导出的账号');
    return;
  }

  const btn = document.getElementById('btn-export-cpa');
  const btnText = document.getElementById('export-btn-text');
  btn.disabled = true;
  btnText.textContent = '导出中...';

  try {
    // 批量获取账号详情（含凭据）
    const resp = await apiFetch('/api/accounts/export', {
      method: 'POST',
      body: JSON.stringify({ account_ids: ids })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || err.message || '获取账号详情失败');
    }

    const data = await resp.json();
    const exportAccounts = data.accounts || [];

    if (exportAccounts.length === 0) {
      showToast('warning', '未获取到可导出的账号数据');
      return;
    }

    // 构建 CPA 格式的 JSON 导出
    const cpaPayload = buildCPAPayload(exportAccounts);

    // 下载文件
    const blob = new Blob([JSON.stringify(cpaPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sub2api_accounts_import.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('success', `已导出 ${exportAccounts.length} 个账号`);
  } catch (err) {
    console.error('Export CPA error:', err);
    showToast('error', err.message);
  } finally {
    btn.disabled = false;
    updateExportButton();
  }
}

function buildCPAPayload(exportAccounts) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const accountsArr = exportAccounts.map(acc => ({
    name: acc.name || '',
    platform: acc.platform || 'openai',
    type: 'codex',
    credentials: acc.credentials || {},
    concurrency: acc.concurrency ?? 3,
    priority: acc.priority ?? 50,
  }));

  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: now,
    proxies: [],
    accounts: accountsArr,
  };
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
    const proxyIdEl = document.getElementById('form-proxy-id');
    const proxyIdVal = proxyIdEl ? proxyIdEl.value : '';
    const reqBody = {};
    if (proxyIdVal) reqBody.proxy_id = parseInt(proxyIdVal);

    const resp = await apiFetch(endpoints.generateUrl, {
      method: 'POST',
      body: JSON.stringify(reqBody),
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
    const proxyIdEl = document.getElementById('form-proxy-id');
    const proxyIdVal = proxyIdEl ? proxyIdEl.value : '';
    if (proxyIdVal) body.proxy_id = parseInt(proxyIdVal);

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
    const creds = {
      access_token: tokenInfo.access_token || '',
      expires_at: tokenInfo.expires_at,
    };
    if (tokenInfo.refresh_token) creds.refresh_token = tokenInfo.refresh_token;
    if (tokenInfo.id_token) creds.id_token = tokenInfo.id_token;
    if (tokenInfo.email) creds.email = tokenInfo.email;
    if (tokenInfo.chatgpt_account_id) creds.chatgpt_account_id = tokenInfo.chatgpt_account_id;
    if (tokenInfo.chatgpt_user_id) creds.chatgpt_user_id = tokenInfo.chatgpt_user_id;
    if (tokenInfo.organization_id) creds.organization_id = tokenInfo.organization_id;
    if (tokenInfo.plan_type) creds.plan_type = tokenInfo.plan_type;
    if (tokenInfo.client_id) creds.client_id = tokenInfo.client_id;
    return creds;
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
window.selectPlatform = selectPlatform;
window.selectType = selectType;
window.deleteAccount = deleteAccount;
window.goToPage = goToPage;
window.toggleSelectAccount = toggleSelectAccount;
window.toggleSelectAll = toggleSelectAll;
window.exportSelectedToCPA = exportSelectedToCPA;

// OAuth flow exposed functions
window.onOAuthMethodChange = onOAuthMethodChange;
window.handleGenerateAuthUrl = handleGenerateAuthUrl;
window.copyOAuthUrl = copyOAuthUrl;
window.handleOpenAuthUrl = handleOpenAuthUrl;
window.onOAuthCodeInput = onOAuthCodeInput;
window.handleExchangeCode = handleExchangeCode;

// ══════════════════════════════════════
// New UI Handlers for Advanced Modules
// ══════════════════════════════════════


// ══════════════════════════════════════
// Platform Model Lists (synced from useModelWhitelist.ts)
// ══════════════════════════════════════

const PLATFORM_MODELS = {
  anthropic: [
    'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307',
    'claude-3-7-sonnet-20250219',
    'claude-sonnet-4-20250514', 'claude-opus-4-20250514',
    'claude-opus-4-1-20250805',
    'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-2.1', 'claude-2.0', 'claude-instant-1.2'
  ],
  openai: [
    'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20',
    'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
    'gpt-4.5-preview',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'o1', 'o1-preview', 'o1-mini', 'o1-pro',
    'o3', 'o3-mini', 'o3-pro',
    'o4-mini',
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
    'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max',
    'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.2-pro',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark',
    'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'chatgpt-4o-latest'
  ],
  gemini: [
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview'
  ],
  antigravity: [
    'claude-opus-4-6', 'claude-opus-4-6-thinking',
    'claude-opus-4-5-thinking',
    'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-5-thinking',
    'gemini-3.1-flash-image', 'gemini-2.5-flash-image',
    'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking',
    'gemini-2.5-pro',
    'gemini-3-flash', 'gemini-3-pro-high', 'gemini-3-pro-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3-pro-image',
    'gpt-oss-120b-medium', 'tab_flash_lite_preview'
  ]
};

const PRESET_MAPPINGS = {
  anthropic: [
    { label: 'Sonnet 4', from: 'claude-sonnet-4-20250514', to: 'claude-sonnet-4-20250514', color: 'chip-blue' },
    { label: 'Sonnet 4.5', from: 'claude-sonnet-4-5-20250929', to: 'claude-sonnet-4-5-20250929', color: 'chip-indigo' },
    { label: 'Sonnet 4.6', from: 'claude-sonnet-4-6', to: 'claude-sonnet-4-6', color: 'chip-indigo' },
    { label: 'Opus 4.5', from: 'claude-opus-4-5-20251101', to: 'claude-opus-4-5-20251101', color: 'chip-purple' },
    { label: 'Opus 4.6', from: 'claude-opus-4-6', to: 'claude-opus-4-6', color: 'chip-purple' },
    { label: 'Haiku 3.5', from: 'claude-3-5-haiku-20241022', to: 'claude-3-5-haiku-20241022', color: 'chip-green' },
    { label: 'Haiku 4.5', from: 'claude-haiku-4-5-20251001', to: 'claude-haiku-4-5-20251001', color: 'chip-teal' },
    { label: 'Opus\u2192Sonnet', from: 'claude-opus-4-6', to: 'claude-sonnet-4-5-20250929', color: 'chip-amber' }
  ],
  openai: [
    { label: 'GPT-4o', from: 'gpt-4o', to: 'gpt-4o', color: 'chip-green' },
    { label: 'GPT-4o Mini', from: 'gpt-4o-mini', to: 'gpt-4o-mini', color: 'chip-blue' },
    { label: 'GPT-4.1', from: 'gpt-4.1', to: 'gpt-4.1', color: 'chip-indigo' },
    { label: 'o1', from: 'o1', to: 'o1', color: 'chip-purple' },
    { label: 'o3', from: 'o3', to: 'o3', color: 'chip-teal' },
    { label: 'GPT-5', from: 'gpt-5', to: 'gpt-5', color: 'chip-amber' },
    { label: 'GPT-5.2', from: 'gpt-5.2', to: 'gpt-5.2', color: 'chip-pink' },
    { label: 'GPT-5.4', from: 'gpt-5.4', to: 'gpt-5.4', color: 'chip-pink' },
    { label: 'GPT-5.1 Codex', from: 'gpt-5.1-codex', to: 'gpt-5.1-codex', color: 'chip-cyan' },
    { label: 'GPT-5.3 Codex Spark', from: 'gpt-5.3-codex-spark', to: 'gpt-5.3-codex-spark', color: 'chip-teal' }
  ],
  gemini: [
    { label: 'Flash 2.0', from: 'gemini-2.0-flash', to: 'gemini-2.0-flash', color: 'chip-blue' },
    { label: '2.5 Flash', from: 'gemini-2.5-flash', to: 'gemini-2.5-flash', color: 'chip-indigo' },
    { label: '2.5 Image', from: 'gemini-2.5-flash-image', to: 'gemini-2.5-flash-image', color: 'chip-cyan' },
    { label: '2.5 Pro', from: 'gemini-2.5-pro', to: 'gemini-2.5-pro', color: 'chip-purple' },
    { label: '3.1 Image', from: 'gemini-3.1-flash-image', to: 'gemini-3.1-flash-image', color: 'chip-cyan' }
  ],
  antigravity: [
    { label: 'Claude\u2192Sonnet', from: 'claude-*', to: 'claude-sonnet-4-5', color: 'chip-blue' },
    { label: 'Sonnet\u2192Sonnet', from: 'claude-sonnet-*', to: 'claude-sonnet-4-5', color: 'chip-indigo' },
    { label: 'Opus\u2192Opus', from: 'claude-opus-*', to: 'claude-opus-4-6-thinking', color: 'chip-purple' },
    { label: 'Haiku\u2192Sonnet', from: 'claude-haiku-*', to: 'claude-sonnet-4-5', color: 'chip-teal' },
    { label: 'Sonnet4\u21924.6', from: 'claude-sonnet-4-20250514', to: 'claude-sonnet-4-6', color: 'chip-cyan' },
    { label: 'Sonnet4.5\u21924.6', from: 'claude-sonnet-4-5-20250929', to: 'claude-sonnet-4-6', color: 'chip-cyan' },
    { label: 'Sonnet3.5\u21924.6', from: 'claude-3-5-sonnet-20241022', to: 'claude-sonnet-4-6', color: 'chip-teal' },
    { label: 'Opus4.5\u21924.6', from: 'claude-opus-4-5-20251101', to: 'claude-opus-4-6-thinking', color: 'chip-pink' },
    { label: 'Gemini 3\u2192Flash', from: 'gemini-3*', to: 'gemini-3-flash', color: 'chip-amber' },
    { label: 'Gemini 2.5\u2192Flash', from: 'gemini-2.5*', to: 'gemini-2.5-flash', color: 'chip-amber' },
    { label: 'Sonnet 4.6', from: 'claude-sonnet-4-6', to: 'claude-sonnet-4-6', color: 'chip-cyan' },
    { label: 'Opus 4.6', from: 'claude-opus-4-6', to: 'claude-opus-4-6-thinking', color: 'chip-pink' }
  ],
  bedrock: [
    { label: 'Opus 4.6', from: 'claude-opus-4-6', to: 'us.anthropic.claude-opus-4-6-v1', color: 'chip-pink' },
    { label: 'Sonnet 4.6', from: 'claude-sonnet-4-6', to: 'us.anthropic.claude-sonnet-4-6', color: 'chip-cyan' },
    { label: 'Opus 4.5', from: 'claude-opus-4-5-thinking', to: 'us.anthropic.claude-opus-4-5-20251101-v1:0', color: 'chip-pink' },
    { label: 'Sonnet 4.5', from: 'claude-sonnet-4-5', to: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', color: 'chip-cyan' },
    { label: 'Haiku 4.5', from: 'claude-haiku-4-5', to: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', color: 'chip-green' }
  ]
};

// Chip color assignment for whitelist mode
const MODEL_CHIP_COLORS = [
  'chip-blue', 'chip-purple', 'chip-green', 'chip-indigo',
  'chip-cyan', 'chip-amber', 'chip-pink', 'chip-teal'
];

// ── Model Whitelist Selector (multi-select dropdown) ──
let _mwsSelectedModels = [];
let _mwsDropdownOpen = false;

function mwsSyncHidden() {
  document.getElementById('form-model-whitelist').value = _mwsSelectedModels.join(',');
}

function mwsRenderTags() {
  const container = document.getElementById('mws-selected-tags');
  const countEl = document.getElementById('mws-count');
  if (!container) return;
  container.innerHTML = '';
  _mwsSelectedModels.forEach(model => {
    const tag = document.createElement('span');
    tag.className = 'mws-tag';
    tag.innerHTML = '<span class="mws-tag-name">' + escapeHtml(model) + '</span><button type="button" class="mws-tag-close">&times;</button>';
    tag.querySelector('.mws-tag-close').addEventListener('click', (e) => {
      e.stopPropagation();
      mwsRemoveModel(model);
    });
    container.appendChild(tag);
  });
  if (countEl) {
    countEl.textContent = _mwsSelectedModels.length > 0
      ? '已选择 ' + _mwsSelectedModels.length + ' 个模型'
      : '已选择 0 个模型（支持所有模型）';
  }
  mwsSyncHidden();
}

function mwsRemoveModel(model) {
  _mwsSelectedModels = _mwsSelectedModels.filter(m => m !== model);
  mwsRenderTags();
  mwsRenderOptions();
}

function mwsToggleModel(model) {
  if (_mwsSelectedModels.includes(model)) {
    _mwsSelectedModels = _mwsSelectedModels.filter(m => m !== model);
  } else {
    _mwsSelectedModels.push(model);
  }
  mwsRenderTags();
  mwsRenderOptions();
}

function mwsRenderOptions(query) {
  const platform = document.getElementById('form-platform').value;
  const models = PLATFORM_MODELS[platform] || PLATFORM_MODELS['anthropic'];
  const container = document.getElementById('mws-options');
  if (!container) return;
  container.innerHTML = '';

  const q = (query || '').toLowerCase().trim();
  const filtered = q ? models.filter(m => m.toLowerCase().includes(q)) : models;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="mws-no-results">没有匹配的模型</div>';
    return;
  }

  filtered.forEach(model => {
    const isSelected = _mwsSelectedModels.includes(model);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mws-option';
    btn.innerHTML = '<span class="mws-check ' + (isSelected ? 'checked' : '') + '"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(model) + '</span>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      mwsToggleModel(model);
    });
    container.appendChild(btn);
  });
}

function mwsToggleDropdown() {
  _mwsDropdownOpen = !_mwsDropdownOpen;
  const dd = document.getElementById('mws-dropdown');
  if (!dd) return;
  if (_mwsDropdownOpen) {
    dd.classList.remove('hidden');
    mwsRenderOptions();
    const searchEl = document.getElementById('mws-search');
    if (searchEl) {
      searchEl.value = '';
      setTimeout(() => searchEl.focus(), 50);
    }
  } else {
    dd.classList.add('hidden');
  }
}

// Auto-fill models for current platform (replaces existing selection)
function mwsAutoFillForPlatform() {
  const platform = document.getElementById('form-platform').value;
  const models = PLATFORM_MODELS[platform] || PLATFORM_MODELS['anthropic'];
  _mwsSelectedModels = [...models];
  mwsRenderTags();
  if (_mwsDropdownOpen) mwsRenderOptions();
}

function mwsFillRelated() {
  const platform = document.getElementById('form-platform').value;
  const models = PLATFORM_MODELS[platform] || PLATFORM_MODELS['anthropic'];
  models.forEach(m => {
    if (!_mwsSelectedModels.includes(m)) _mwsSelectedModels.push(m);
  });
  mwsRenderTags();
  mwsRenderOptions();
}

function mwsClearAll() {
  _mwsSelectedModels = [];
  mwsRenderTags();
  mwsRenderOptions();
}

function mwsAddCustom() {
  const input = document.getElementById('mws-custom-input');
  const val = (input.value || '').trim();
  if (!val) return;
  if (_mwsSelectedModels.includes(val)) return;
  _mwsSelectedModels.push(val);
  input.value = '';
  mwsRenderTags();
  mwsRenderOptions();
}

function renderModelChips() {
  // Called on platform change / initial — auto-fill if empty
  if (_mwsSelectedModels.length === 0) {
    mwsAutoFillForPlatform();
  } else {
    mwsRenderTags();
    if (_mwsDropdownOpen) mwsRenderOptions();
  }
}

function renderPresetMappings() {
  const platform = document.getElementById('form-platform').value;
  const type = document.getElementById('form-type').value;
  const container = document.getElementById('preset-mappings-area');
  if (!container) return;
  container.innerHTML = '';

  const key = (platform === 'antigravity' && type === 'bedrock') ? 'bedrock' : platform;
  const presets = PRESET_MAPPINGS[key] || PRESET_MAPPINGS['anthropic'];

  presets.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-mapping-chip ' + p.color;
    btn.textContent = '+ ' + p.label;
    btn.addEventListener('click', () => addModelMapping(p.from, p.to));
    container.appendChild(btn);
  });
}

window.setModelMode = function(mode) {
  const wlBtn = document.getElementById('btn-mode-whitelist');
  const mpBtn = document.getElementById('btn-mode-mapping');
  const wlArea = document.getElementById('whitelist-area');
  const mpArea = document.getElementById('mapping-area');
  if (mode === 'whitelist') {
    if(wlBtn) wlBtn.classList.add('active');
    if(mpBtn) mpBtn.classList.remove('active');
    wlArea.classList.remove('hidden');
    mpArea.classList.add('hidden');
    // Auto-fill related models on mode switch (matches sub2api: watch modelRestrictionMode)
    mwsAutoFillForPlatform();
    renderModelChips();
  } else {
    if(mpBtn) mpBtn.classList.add('active');
    if(wlBtn) wlBtn.classList.remove('active');
    mpArea.classList.remove('hidden');
    wlArea.classList.add('hidden');
    renderPresetMappings();
  }
};

window.onBedrockAuthModeChange = function() {
  const mode = document.getElementById('form-bedrock-auth-mode').value;
  if (mode === 'sigv4') {
    document.getElementById('bedrock-sigv4-area').classList.remove('hidden');
    document.getElementById('bedrock-apikey-area').classList.add('hidden');
  } else {
    document.getElementById('bedrock-apikey-area').classList.remove('hidden');
    document.getElementById('bedrock-sigv4-area').classList.add('hidden');
  }
};

function renderErrorCodes() {
  const c = document.getElementById('selected-error-codes');
  const input = document.getElementById('form-custom-error-codes');
  let codes = [];
  try { codes = JSON.parse(input.value || '[]'); } catch(e){}
  c.innerHTML = '';
  codes.forEach(code => {
    const el = document.createElement('span');
    el.className = 'error-tag';
    el.style = 'background:#e2e8f0; padding:2px 8px; border-radius:12px; font-size:12px; display:inline-flex; align-items:center; gap:4px;';
    el.innerHTML = `${code} <button type="button" class="js-err-close" style="background:none; border:none; cursor:pointer; font-size:14px; line-height:1;">&times;</button>`;
    el.querySelector('.js-err-close').addEventListener('click', () => toggleErrorCode('str_' + code));
    c.appendChild(el);
  });
}

window.toggleErrorCode = function(code) {
  if (typeof code === 'string' && code.startsWith('str_')) code = code.substring(4);
  const input = document.getElementById('form-custom-error-codes');
  let codes = [];
  try { codes = JSON.parse(input.value || '[]'); } catch(e){}
  const intCode = parseInt(code);
  if (isNaN(intCode)) return;
  if (codes.includes(intCode)) {
    codes = codes.filter(c => c !== intCode);
  } else {
    codes.push(intCode);
  }
  input.value = JSON.stringify(codes);
  renderErrorCodes();
};

window.addCustomErrorCode = function() {
  const inputEl = document.getElementById('custom-error-input');
  const val = inputEl.value;
  if(val) {
    window.toggleErrorCode(val);
    inputEl.value = '';
  }
};

let _tempRules = [];
window.addTempRule = function(code='', duration='', kw=[''], title='') {
  const container = document.getElementById('temp-rules-container');
  const id = Date.now().toString() + Math.floor(Math.random()*1000);
  
  const div = document.createElement('div');
  div.className = 'temp-rule-card';
  div.style = 'border:1px solid #e5e7eb; border-radius:6px; padding:10px; position:relative;';
  div.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm js-temp-del" style="position:absolute; right:10px; top:10px;">删除</button>
    <div style="display:flex; gap:12px; margin-bottom:8px; padding-right:50px;">
      <div style="flex:1;"><label>状态码</label><input type="number" class="tr-code" value="${code||''}" placeholder="400" /></div>
      <div style="flex:1;"><label>不可用时长(分钟)</label><input type="number" class="tr-dur" value="${duration||''}" placeholder="30" /></div>
    </div>
    <div>
      <label>错误关键字 (逗号分隔)</label>
      <input type="text" class="tr-kw" value="${kw.join(',')}" placeholder="例如: your account has been restricted" />
    </div>
  `;
  div.dataset.id = id;
  div.querySelector('.js-temp-del').addEventListener('click', () => delTempRule(id));
  div.querySelectorAll('input').forEach(inp => inp.addEventListener('change', syncTempRules));
  container.appendChild(div);
  syncTempRules();
};

window.delTempRule = function(id) {
  const container = document.getElementById('temp-rules-container');
  const child = Array.from(container.children).find(c => c.dataset.id === id);
  if (child) container.removeChild(child);
  syncTempRules();
};

window.syncTempRules = function() {
  const container = document.getElementById('temp-rules-container');
  const rules = Array.from(container.children).map(c => {
    return {
      code: c.querySelector('.tr-code').value,
      duration: c.querySelector('.tr-dur').value,
      keywords: c.querySelector('.tr-kw').value.split(',').map(s=>s.trim()).filter(Boolean)
    };
  }).filter(r => r.code && r.duration);
  document.getElementById('form-temp-rules').value = JSON.stringify(rules);
};

window.toggleQC = function(type) {
  const cb = document.getElementById('qc-'+type);
  const group = document.getElementById('qcg-'+type);
  if (group) {
    if (cb.checked) group.classList.remove('hidden');
    else group.classList.add('hidden');
  }
  syncQC();
};

document.addEventListener('DOMContentLoaded', () => {
    const qcSec = document.getElementById('quota-control-section');
    if (qcSec) {
        qcSec.addEventListener('change', syncQC);
        qcSec.addEventListener('input', syncQC);
    }
});

// syncQC is no longer used — quota control is now serialized directly by applyQuotaControlToExtra()
function syncQC() {}

/**
 * Apply quota control fields directly into the extra object (flat structure).
 * Backend reads: window_cost_limit, window_cost_sticky_reserve,
 *   max_sessions, session_idle_timeout_minutes, base_rpm, rpm_strategy,
 *   rpm_sticky_buffer, user_msg_queue_mode, enable_tls_fingerprint,
 *   tls_fingerprint_profile_id, session_id_masking_enabled,
 *   cache_ttl_override_enabled, cache_ttl_override_target,
 *   custom_base_url_enabled, custom_base_url
 */
function applyQuotaControlToExtra(extra) {
  // Window Cost
  const wcToggle = document.getElementById('toggle-window-cost');
  if (wcToggle && wcToggle.classList.contains('bg-primary-600')) {
    const limit = parseFloat(document.getElementById('v-window-cost-limit')?.value);
    if (!isNaN(limit) && limit > 0) {
      extra.window_cost_limit = limit;
      const reserve = parseFloat(document.getElementById('v-window-cost-reserve')?.value);
      extra.window_cost_sticky_reserve = (!isNaN(reserve) && reserve > 0) ? reserve : 10;
    }
  }

  // Session Limit
  const slToggle = document.getElementById('toggle-session-limit');
  if (slToggle && slToggle.classList.contains('bg-primary-600')) {
    const maxSess = parseInt(document.getElementById('v-session-max')?.value);
    if (!isNaN(maxSess) && maxSess > 0) {
      extra.max_sessions = maxSess;
      const idle = parseInt(document.getElementById('v-session-idle')?.value);
      extra.session_idle_timeout_minutes = (!isNaN(idle) && idle > 0) ? idle : 5;
    }
  }

  // RPM Limit
  const rpmToggle = document.getElementById('toggle-rpm-limit');
  if (rpmToggle && rpmToggle.classList.contains('bg-primary-600')) {
    const DEFAULT_BASE_RPM = 15;
    const baseRpm = parseInt(document.getElementById('v-rpm-base')?.value);
    extra.base_rpm = (!isNaN(baseRpm) && baseRpm > 0) ? baseRpm : DEFAULT_BASE_RPM;
    extra.rpm_strategy = document.getElementById('v-rpm-strategy')?.value || 'tiered';
    const buffer = parseInt(document.getElementById('v-rpm-buffer')?.value);
    if (!isNaN(buffer) && buffer > 0) {
      extra.rpm_sticky_buffer = buffer;
    }
  }

  // User Message Queue Mode (independent of RPM)
  const umqMode = document.getElementById('v-user-msg-queue')?.value;
  if (umqMode) {
    extra.user_msg_queue_mode = umqMode;
  }

  // TLS Fingerprint
  const tlsToggle = document.getElementById('toggle-tls');
  if (tlsToggle && tlsToggle.classList.contains('bg-primary-600')) {
    extra.enable_tls_fingerprint = true;
    const profileId = document.getElementById('v-tls-profile')?.value;
    if (profileId) {
      extra.tls_fingerprint_profile_id = parseInt(profileId);
    }
  }

  // Session ID Masking
  const maskToggle = document.getElementById('toggle-session-mask');
  if (maskToggle && maskToggle.classList.contains('bg-primary-600')) {
    extra.session_id_masking_enabled = true;
  }

  // Cache TTL Override
  const cacheTtlToggle = document.getElementById('toggle-cache-ttl');
  if (cacheTtlToggle && cacheTtlToggle.classList.contains('bg-primary-600')) {
    extra.cache_ttl_override_enabled = true;
    extra.cache_ttl_override_target = document.getElementById('v-cache-target')?.value || '5m';
  }

  // Custom Base URL
  const customUrlToggle = document.getElementById('toggle-custom-url');
  if (customUrlToggle && customUrlToggle.classList.contains('bg-primary-600')) {
    const url = document.getElementById('v-custom-url')?.value?.trim();
    if (url) {
      extra.custom_base_url_enabled = true;
      extra.custom_base_url = url;
    }
  }
}
