(function (root) {
  'use strict';

  const PLATFORM_NAMES = { anthropic: 'Anthropic', claude: 'Claude', openai: 'OpenAI', gemini: 'Google Gemini',
    google: 'Google', grok: 'Grok', minimax: 'MiniMax', deepseek: 'DeepSeek', '(unknown)': '未知平台', '(aggregate)': '模型汇总' };
  const PLATFORM_COLORS = { anthropic: '#cf8471', claude: '#cf8471', openai: '#4d9b88', gemini: '#5385bc',
    google: '#5385bc', grok: '#9283ac', minimax: '#b79b50', deepseek: '#729ca7', '(unknown)': '#9aa4a7', '(aggregate)': '#9aa4a7' };
  const EXTRA_COLORS = ['#9283ac', '#b79b50', '#729ca7', '#b98095', '#7b9e69', '#788ca8'];
  const METRICS = { requests: { name: '请求数', unit: '次', total: '总请求', share: '请求占比' },
    tokens: { name: 'Token', unit: 'Token', total: '总 Token', share: 'Token 占比' },
    cost: { name: '消费额度', unit: '额度', total: '总消费', share: '消费占比' } };
  const integer = (value) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value || 0));
  const decimal = (value, digits = 4) => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value));
  const money = (value) => value != null && value > 0 && value < 0.0001 ? '< 0.0001' : decimal(value);
  const percent = (value, total) => total > 0 && value != null
    ? value > 0 && value / total < 0.001 ? '< 0.1%' : `${decimal(value / total * 100, 1)}%` : '—';
  const shortNumber = (value) => Math.abs(value) >= 1000000 ? `${decimal(value / 1000000, 2)}M`
    : Math.abs(value) >= 10000 ? `${decimal(value / 1000, 1)}k` : integer(value);
  const platformName = (value) => PLATFORM_NAMES[value] || value;
  function platformColor(value) {
    if (PLATFORM_COLORS[value]) return PLATFORM_COLORS[value];
    let hash = 0;
    for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return EXTRA_COLORS[hash % EXTRA_COLORS.length];
  }
  function addDays(value, days) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function createRequestGate() {
    let sequence = 0;
    return { next: () => ++sequence, current: (token) => token === sequence, invalidate: () => ++sequence };
  }
  function dailyRows(detail) {
    const rows = new Map(detail.trend.map((row) => [row.date, row]));
    const uncertain = new Set([...detail.coverage.selected.missingDays, ...detail.coverage.selected.unverifiedDays]);
    const days = [];
    for (let date = detail.range.start; date <= detail.range.end; date = addDays(date, 1)) {
      const row = rows.get(date);
      days.push({ date, requests: row?.requests ?? (uncertain.has(date) ? null : 0),
        cost: row?.cost ?? (uncertain.has(date) ? null : 0), uncertain: uncertain.has(date) });
    }
    return days;
  }

  function create({ api, escapeHtml: esc, icon, refreshIcons, toast, setPageMeta, setConnection, isActive }) {
    const $ = (id) => document.getElementById(id);
    const mainGate = createRequestGate(), usersGate = createRequestGate(), detailGate = createRequestGate();
    const charts = new Map();
    let options = null, base = null, report = null, users = null, detail = null;
    let metric = 'requests', detailMetric = 'requests', segment = 'all', sort = 'cost', search = '', page = 1, pageSize = 20;
    let mainAbort = null, usersAbort = null, detailAbort = null, exportAbort = null, searchTimer = null;

    function paint(node) {
      node.querySelectorAll('[data-up-color]').forEach((el) => { el.style.backgroundColor = el.dataset.upColor; });
      node.querySelectorAll('[data-up-width]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.upWidth)))}%`; });
    }
    const dot = (platform) => `<span class="up-dot" data-up-color="${platformColor(platform)}" aria-hidden="true"></span>`;
    const amount = (value, mode) => mode === 'cost' ? money(value) : shortNumber(value);
    function pressed(id, attribute, value) {
      $(id).querySelectorAll(`[data-${attribute}]`).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset[attribute] === value)));
    }
    function makeChart(id, option) {
      if (!root.echarts) return;
      let instance = charts.get(id);
      if (!instance) {
        instance = root.echarts.init($(id), null, { renderer: 'canvas' });
        charts.set(id, instance);
      }
      instance.setOption({ animationDuration: 200, textStyle: { fontFamily: 'Inter, Segoe UI, Microsoft YaHei, sans-serif', color: '#69716b' },
        tooltip: { renderMode: 'richText' }, ...option }, true);
      instance.resize();
    }
    function disposeCharts() {
      charts.forEach((instance) => instance.dispose());
      charts.clear();
    }
    function showStatus(message, error = false) {
      $('up-data').hidden = true;
      $('up-status').hidden = false;
      $('up-status').textContent = message;
      $('up-status').classList.toggle('up-error', error);
    }
    function listQuery() {
      return { ...base, metric, segment, sort, search, page, pageSize };
    }
    function queryPath(path, query) {
      return `${path}?${new URLSearchParams(query)}`;
    }
    function resetList() {
      page = 1;
      usersGate.invalidate();
      clearTimeout(searchTimer);
    }
    function syncPresets() {
      const form = $('up-filter');
      const days = Math.round((Date.parse(form.elements.end.value) - Date.parse(form.elements.start.value)) / 86400000) + 1;
      $('up-presets').querySelectorAll('[data-days]').forEach((button) => {
        button.setAttribute('aria-pressed', String(days === Number(button.dataset.days) && form.elements.end.value === options?.today));
      });
    }
    function renderNotices(data) {
      const messages = [...(data.warnings || [])];
      if (data.coverage.selected.status === 'partial') messages.push('所选范围存在已清理或缺失的用量明细，以下消费、占比与活跃天数仅反映保留记录。');
      if (data.coverage.selected.status === 'unverified') messages.push('部分日期尚无法与站点日汇总核对，以下数据基于当前保留明细。');
      if (!data.recent.available) messages.push('最近 14 天明细覆盖未核验完整，活跃下降与余额预计天数暂不可用。');
      if (data.platforms.some((p) => p.platform === '(unknown)')) messages.push('存在无法归属平台的用量，已独立计入“未知平台”，消费总额仍包含这些记录。');
      $('up-notices').innerHTML = messages.map((message) => `<div class="alert warning">${icon('info')}<span>${esc(message)}</span></div>`).join('');
      $('up-coverage-label').textContent = data.coverage.selected.status === 'matched'
        ? `${data.timezone} · 明细数量已核对 · 当天持续更新`
        : `${data.timezone} · ${data.coverage.selected.status === 'partial' ? '保留明细，覆盖不完整' : '明细覆盖尚未全部核验'}`;
      refreshIcons();
    }
    function renderMetrics() {
      const s = report.summary;
      const retained = report.coverage.selected.status === 'partial' ? ' · 保留明细' : '';
      const cards = [
        ['区间活跃用户', integer(s.users), `去重使用用户${retained}`, 'users'],
        ['实际消费额度', money(s.cost), `所选计费类型 · 额度${retained}`, 'wallet'],
        ['人均消费额度', money(s.average_cost), '区间消费 / 区间活跃用户', 'chart-no-axes-column-increasing'],
        ['多平台使用率', s.multi_rate == null ? '—' : percent(s.multi_users, s.users), `${integer(s.multi_users)} 位用户使用至少两个已识别平台`, 'network']
      ];
      $('up-metrics').innerHTML = cards.map(([name, value, caption, symbol]) => `<div class="up-metric"><div class="up-metric-heading"><span>${name}</span>${icon(symbol)}</div><strong class="up-metric-value">${esc(value)}</strong><small>${esc(caption)}</small></div>`).join('');
      refreshIcons();
    }
    function renderPreferences() {
      const spec = METRICS[metric], total = report.summary[metric];
      const platforms = [...report.platforms].sort((a, b) => b[metric] - a[metric] || a.platform.localeCompare(b.platform));
      $('up-donut-label').textContent = spec.total;
      $('up-donut-value').textContent = amount(total, metric);
      $('up-platform-count').textContent = `${integer(platforms.length)} 个平台`;
      $('up-platform-chart').setAttribute('aria-label', `平台${spec.share}：${platforms.map((p) => `${platformName(p.platform)} ${percent(p[metric], total)}`).join('，') || '无用量'}`);
      makeChart('up-platform-chart', {
        tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p) => `${p.name}\n${amount(p.value, metric)} ${spec.unit} · ${percent(p.value, total)}` },
        series: [{ type: 'pie', radius: ['70%', '87%'], center: ['50%', '50%'], label: { show: false },
          emptyCircleStyle: { color: '#eef2ef' }, itemStyle: { borderWidth: 3, borderColor: '#fff', borderRadius: 2 },
          data: platforms.map((p) => ({ name: platformName(p.platform), value: p[metric], itemStyle: { color: platformColor(p.platform) } })) }]
      });
      $('up-platform-legend').innerHTML = platforms.length ? platforms.map((p) => `<div class="up-legend-row">${dot(p.platform)}<strong>${esc(platformName(p.platform))}</strong><b>${percent(p[metric], total)}</b><small>${esc(amount(p[metric], metric))} ${spec.unit}</small></div>`).join('') : '<p class="up-empty">所选范围暂无使用记录</p>';
      const models = report.models[metric];
      const max = Math.max(0, ...models.map((m) => m[metric]));
      $('up-model-bars').innerHTML = models.length ? models.map((m) => `<div class="up-model-row" title="${esc(`${platformName(m.platform)} · ${m.model}：${amount(m[metric], metric)} ${spec.unit}`)}"><span class="up-model-name">${dot(m.platform)}<span>${esc(m.model)}</span></span><div class="up-model-track"><span class="up-model-fill" data-up-color="${platformColor(m.platform)}" data-up-width="${max > 0 ? m[metric] / max * 100 : 0}"></span></div><b>${percent(m[metric], total)}</b></div>`).join('') : '<p class="up-empty">所选范围暂无模型用量</p>';
      paint($('up-data'));
      pressed('up-modes', 'metric', metric);
      $('up-platform-table-heading').textContent = `平台偏好 · ${spec.name}`;
    }
    function renderInsights() {
      const names = ['前 20%', '中间 30%', '剩余用户'], colors = ['#4d9b88', '#8fb6a2', '#d1e0d6'];
      const segments = [0, 1, 2].map((band) => report.concentration.find((c) => c.band === band) || { band, users: 0, cost: 0 });
      const total = report.summary.cost;
      $('up-concentration-value').textContent = percent(segments[0].cost, total);
      $('up-concentration-description').textContent = `前 ${integer(segments[0].users)} 位用户贡献的消费占比，区间共 ${integer(report.summary.users)} 位活跃用户`;
      $('up-concentration-bar').innerHTML = segments.map((s, i) => `<span data-up-color="${colors[i]}" data-up-width="${total > 0 ? s.cost / total * 100 : 0}" title="${names[i]} · ${integer(s.users)} 人 · ${money(s.cost)} 额度"></span>`).join('');
      $('up-concentration-bar').setAttribute('aria-label', segments.map((s, i) => `${names[i]} ${integer(s.users)} 人，消费占比 ${percent(s.cost, total)}`).join('；'));
      $('up-concentration-legend').innerHTML = segments.map((s, i) => `<span><span class="up-dot" data-up-color="${colors[i]}"></span>${names[i]} · ${integer(s.users)} 人<b>${percent(s.cost, total)}</b></span>`).join('');
      $('up-recent-period').textContent = `${report.recent.start.slice(5)} 至 ${report.recent.end.slice(5)} · 含今天`;
      for (const [key, field] of [['decline', 'declining'], ['balance', 'low_balance']]) {
        const count = report.attention[field];
        $(`up-${key}-count`).innerHTML = count == null ? '<small>不可用</small>' : `${integer(count)}<small>人</small>`;
        $(`up-attention-${key}`).disabled = count == null;
        $('up-segments').querySelector(`[data-segment="${key}"]`).disabled = count == null;
      }
      paint($('up-data'));
    }
    function tagList(user) {
      const tags = [];
      if (user.high_consumption) tags.push('<span class="up-tag">高消费</span>');
      if (user.platform_count >= 2) tags.push('<span class="up-tag up-multi">多平台</span>');
      if (user.declining) tags.push('<span class="up-tag up-decline">活跃下降</span>');
      if (user.low_balance) tags.push('<span class="up-tag up-balance">低余额</span>');
      if (user.deleted) tags.push('<span class="up-tag up-deleted">已删除 / 缺失</span>');
      return tags.join('') || '<span class="up-tag">常规使用</span>';
    }
    function platformStack(user, mode) {
      const denominator = user[mode];
      return user.platforms.map((p) => `<span data-up-color="${platformColor(p.platform)}" data-up-width="${denominator > 0 ? p[mode] / denominator * 100 : 0}" title="${esc(platformName(p.platform))}：${percent(p[mode], denominator)}"></span>`).join('');
    }
    function renderUsers() {
      const p = users.pagination;
      $('up-user-count').textContent = `${integer(p.total)} 人`;
      $('up-denominator').textContent = `消费占比分母：${money(users.totalConsumption)} 额度`;
      $('up-user-rows').innerHTML = users.items.length ? users.items.map((u, i) => {
        const label = `${u.name} · ID ${u.id}`;
        const platformLabel = u.platforms.map((v) => `${platformName(v.platform)} ${percent(v[metric], u[metric])}`).join('，');
        return `<tr><td>${integer((p.page - 1) * p.pageSize + i + 1)}</td><td><div class="up-user-cell"><span class="up-avatar ${i % 3 === 1 ? 'up-avatar-blue' : i % 3 === 2 ? 'up-avatar-coral' : ''}" aria-hidden="true">${esc(Array.from(u.name).slice(0, 2).join(''))}</span><div><button class="up-user-name" type="button" data-user="${esc(u.id)}" title="${esc(label)}" aria-label="查看${esc(label)}的画像">${esc(u.name)}</button><div class="up-user-email" title="${esc(u.email)}">${esc(u.email || `ID ${u.id}`)}</div></div></div></td><td class="up-platform-cell"><div class="up-mini-stack" role="img" aria-label="${esc(platformLabel || '所选范围无请求')}">${platformStack(u, metric)}</div><div class="up-preferred-model" title="${esc(u.preferred_model?.model || '')}">${esc(u.preferred_model?.model || '所选范围无请求')}</div></td><td class="numeric up-cost-cell">${money(u.cost)}</td><td class="numeric">${u.consumption_share == null ? '—' : percent(u.cost, users.totalConsumption)}<div class="up-share-track"><span data-up-width="${(u.consumption_share || 0) * 100}"></span></div></td><td class="numeric">${integer(u.requests)}</td><td class="numeric">${integer(u.active_days)} <span class="muted">/ ${users.range.days}</span></td><td><div class="up-tags">${tagList(u)}</div></td><td><button class="icon-button" type="button" data-user="${esc(u.id)}" aria-label="打开${esc(label)}详情" title="查看用户画像">${icon('arrow-up-right')}</button></td></tr>`;
      }).join('') : '<tr><td colspan="9" class="up-empty">没有符合当前筛选的用户</td></tr>';
      const first = p.total ? (p.page - 1) * p.pageSize + 1 : 0;
      $('up-pagination-label').textContent = `显示 ${integer(first)}–${integer(Math.min(p.page * p.pageSize, p.total))} / ${integer(p.total)} 人`;
      $('up-page-label').textContent = `${p.page} / ${Math.max(1, p.pages)}`;
      $('up-prev').disabled = p.page <= 1;
      $('up-next').disabled = !p.hasNext;
      $('up-export').disabled = p.total === 0;
      pressed('up-segments', 'segment', segment);
      paint($('up-user-rows'));
      refreshIcons();
    }

    async function load({ refresh = false } = {}) {
      const token = mainGate.next();
      usersGate.invalidate();
      mainAbort?.abort(); usersAbort?.abort(); exportAbort?.abort();
      mainAbort = new AbortController();
      closeDetails();
      showStatus('正在读取用户画像');
      $('up-notices').innerHTML = '';
      setPageMeta('正在读取用户平台、模型与消费画像');
      try {
        if (!options || refresh) {
          const nextOptions = await api('/api/user-profiles/options', { signal: mainAbort.signal });
          if (!mainGate.current(token) || !isActive()) return;
          const initial = !options;
          options = nextOptions;
          const form = $('up-filter');
          for (const key of ['start', 'end']) {
            form.elements[key].min = options.earliest;
            form.elements[key].max = options.today;
            if (initial) form.elements[key].value = options.defaultRange[key];
          }
          const selected = form.elements.platform.value;
          form.elements.platform.innerHTML = '<option value="all">全部平台</option>' + options.platforms.map((p) => `<option value="${esc(p)}">${esc(platformName(p))}</option>`).join('');
          form.elements.platform.value = options.platforms.includes(selected) ? selected : 'all';
          $('up-presets').querySelector('[data-days="30"]').disabled = options.maxDays < 30;
        }
        if (!mainGate.current(token) || !isActive()) return;
        base = Object.fromEntries(new FormData($('up-filter')));
        syncPresets();
        page = 1;
        const usersToken = usersGate.next(), requestedSegment = segment;
        const [nextReport, nextUsers] = await Promise.all([
          api(queryPath('/api/user-profiles', base), { signal: mainAbort.signal }),
          api(queryPath('/api/user-profiles/users', listQuery()), { signal: mainAbort.signal })
        ]);
        if (!mainGate.current(token) || !usersGate.current(usersToken) || !isActive()) return;
        report = nextReport; users = nextUsers;
        if ((segment === 'decline' && report.attention.declining == null) || (segment === 'balance' && report.attention.low_balance == null)) {
          segment = 'all';
        }
        $('up-status').hidden = true;
        $('up-data').hidden = false;
        renderMetrics(); renderNotices(report); renderPreferences(); renderInsights();
        if (segment !== requestedSegment) await loadUsers(); else renderUsers();
        if (!mainGate.current(token) || !isActive()) return;
        setPageMeta(`${report.range.start} 至 ${report.range.end} · ${report.timezone} · 更新于 ${dateTime(report.generatedAt, report.timezone)}`);
      } catch (error) {
        if (!mainGate.current(token) || !isActive() || error.name === 'AbortError') return;
        report = null; users = null;
        disposeCharts();
        showStatus(`无法读取用户画像：${error.message}`, true);
        throw error;
      }
    }

    async function loadUsers() {
      if (!base || !report || !isActive()) return;
      const token = usersGate.next();
      usersAbort?.abort(); exportAbort?.abort();
      usersAbort = new AbortController();
      users = null;
      $('up-user-rows').innerHTML = '<tr><td colspan="9" class="up-empty">正在读取用户明细</td></tr>';
      $('up-user-count').textContent = '';
      $('up-pagination-label').textContent = '读取中';
      $('up-export').disabled = true;
      $('up-prev').disabled = true; $('up-next').disabled = true;
      pressed('up-segments', 'segment', segment);
      try {
        const nextUsers = await api(queryPath('/api/user-profiles/users', listQuery()), { signal: usersAbort.signal });
        if (!usersGate.current(token) || !isActive()) return;
        if (nextUsers.pagination.pages > 0 && page > nextUsers.pagination.pages) {
          page = nextUsers.pagination.pages;
          return loadUsers();
        }
        users = nextUsers;
        renderUsers();
      } catch (error) {
        if (!usersGate.current(token) || !isActive() || error.name === 'AbortError') return;
        $('up-user-rows').innerHTML = `<tr><td colspan="9" class="up-empty">读取失败：${esc(error.message)}</td></tr>`;
        throw error;
      }
    }
    function dateTime(value, timezone) {
      return value ? new Date(value).toLocaleString('zh-CN', { timeZone: timezone, hour12: false }) : '—';
    }
    function modalState() {
      document.body.classList.toggle('up-modal-open', $('up-drawer').open || $('up-definitions').open);
    }
    function closeDetails() {
      detailGate.invalidate();
      detailAbort?.abort();
      detail = null;
      if ($('up-drawer').open) $('up-drawer').close();
      $('up-detail-content').hidden = true;
      $('up-detail-name').textContent = '用户画像';
      $('up-detail-email').textContent = '';
      modalState();
    }
    function detailTab(name) {
      $('up-detail-tabs').querySelectorAll('[data-tab]').forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.tab === name));
        button.tabIndex = button.dataset.tab === name ? 0 : -1;
      });
      $('up-preference-panel').hidden = name !== 'preference';
      $('up-activity-panel').hidden = name !== 'activity';
      if (name === 'activity' && detail) renderActivity();
    }
    function renderDetail() {
      const user = detail.user;
      $('up-detail-name').textContent = user.name;
      $('up-detail-email').textContent = `${user.email || '邮箱不可用'} · ID ${user.id}${user.deleted ? ' · 已删除或缺失' : ''}`;
      $('up-detail-meta').textContent = `${detail.range.start} 至 ${detail.range.end} · ${detail.timezone}${detail.coverage.selected.status !== 'matched' ? ' · 基于保留明细，覆盖尚未核验完整' : ''}`;
      $('up-detail-metrics').innerHTML = [
        ['消费额度', money(user.cost), user.consumption_share == null ? '消费占比 —' : `占区间消费 ${percent(user.consumption_share, 1)}`],
        ['请求数', integer(user.requests), `${shortNumber(user.tokens)} Token`],
        ['活跃天数', integer(user.active_days), `所选范围共 ${detail.range.days} 天`]
      ].map(([label, value, caption]) => `<div><span>${label}</span><strong>${esc(value)}</strong><small>${esc(caption)}</small></div>`).join('');
      const components = [['输入 Token', 'input_tokens', '#4d9b88'], ['输出 Token', 'output_tokens', '#5385bc'], ['缓存读取', 'cache_read_tokens', '#9283ac'], ['缓存创建', 'cache_creation_tokens', '#cf8471']];
      $('up-detail-token-total').textContent = `共 ${shortNumber(user.tokens)} Token`;
      $('up-detail-tokens').innerHTML = components.map(([label, key, color]) => `<div><span class="up-token-label"><span class="up-dot" data-up-color="${color}"></span>${label}</span><strong class="up-token-value">${shortNumber(user[key])}<small>${percent(user[key], user.tokens)}</small></strong></div>`).join('');
      paint($('up-detail-content'));
      renderDetailPreferences();
    }
    function renderDetailPreferences() {
      if (!detail) return;
      const user = detail.user, spec = METRICS[detailMetric], denominator = user[detailMetric];
      const platforms = [...detail.platforms].sort((a, b) => b[detailMetric] - a[detailMetric]);
      $('up-detail-mode-label').textContent = spec.share;
      $('up-detail-platform-bar').innerHTML = platformStack({ ...user, platforms }, detailMetric);
      $('up-detail-platform-bar').setAttribute('aria-label', platforms.map((p) => `${platformName(p.platform)} ${percent(p[detailMetric], denominator)}`).join('，') || '所选范围无用量');
      $('up-detail-platform-legend').innerHTML = platforms.map((p) => `<span>${dot(p.platform)}${esc(platformName(p.platform))}<b>${percent(p[detailMetric], denominator)}</b></span>`).join('') || '<span>所选范围暂无平台用量</span>';
      $('up-detail-share-heading').textContent = spec.share;
      const models = detail.models[detailMetric];
      $('up-detail-model-rows').innerHTML = models.length ? models.map((m) => `<tr><td><span class="up-model-name">${dot(m.platform)}<span title="${esc(m.model)}">${esc(m.model)}</span></span><small>${esc(platformName(m.platform))}</small></td><td class="numeric">${integer(m.requests)}</td><td class="numeric">${money(m.cost)}</td><td class="numeric">${percent(m[detailMetric], denominator)}</td></tr>`).join('') : '<tr><td colspan="4" class="up-empty">所选范围暂无模型用量</td></tr>';
      pressed('up-detail-modes', 'metric', detailMetric);
      paint($('up-detail-content'));
    }
    function renderActivity() {
      const days = dailyRows(detail), user = detail.user;
      makeChart('up-detail-trend', {
        grid: { left: 53, right: 48, top: 35, bottom: 30 },
        tooltip: { trigger: 'axis', renderMode: 'richText' },
        legend: { data: ['消费额度', '请求数'], right: 10, top: 0, textStyle: { fontSize: 11 } },
        xAxis: { type: 'category', data: days.map((d) => d.date.slice(5)), boundaryGap: false, axisLabel: { fontSize: 10 }, axisLine: { lineStyle: { color: '#dfe5e0' } } },
        yAxis: [{ type: 'value', splitLine: { lineStyle: { color: '#edf1ed' } }, axisLabel: { fontSize: 10 } }, { type: 'value', minInterval: 1, splitLine: { show: false }, axisLabel: { fontSize: 10 } }],
        series: [{ name: '消费额度', type: 'line', data: days.map((d) => d.uncertain ? null : d.cost), symbolSize: 4, itemStyle: { color: '#4d9b88' }, lineStyle: { width: 2 }, areaStyle: { opacity: 0.06 } },
          { name: '请求数', type: 'line', yAxisIndex: 1, data: days.map((d) => d.uncertain ? null : d.requests), symbolSize: 4, itemStyle: { color: '#5385bc' }, lineStyle: { width: 1.5 } }]
      });
      const max = Math.max(1, ...days.map((d) => d.requests || 0));
      const cells = [];
      let month = '';
      for (const day of days) {
        if (month !== day.date.slice(0, 7)) {
          month = day.date.slice(0, 7);
          cells.push(`<div class="up-calendar-month">${month} · 一 二 三 四 五 六 日</div>`);
          const weekday = (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7;
          for (let i = 0; i < weekday; i++) cells.push('<span aria-hidden="true"></span>');
        }
        const level = day.uncertain ? 'unknown' : day.requests > 0 ? Math.max(1, Math.ceil(day.requests / max * 4)) : 0;
        const title = `${day.date}：${day.uncertain ? '明细覆盖未核验完整' : `${integer(day.requests)} 次请求 · ${money(day.cost)} 额度`}`;
        cells.push(`<span class="up-calendar-day up-level-${level}" title="${esc(title)}" aria-label="${esc(title)}">${Number(day.date.slice(8))}</span>`);
      }
      $('up-calendar').innerHTML = cells.join('');
      $('up-calendar-summary').textContent = `${integer(user.active_days)} 个观测活跃日${days.some((d) => d.uncertain) ? ' · 斜纹日期覆盖未核验' : ''}`;
      const statusNames = { active: '正常', disabled: '已停用', banned: '已封禁' };
      const stateRows = [
        ['当前可用余额', user.balance == null ? '不可用' : `${money(user.balance)} 额度`],
        ['余额预计可用', user.runway_days == null ? '不估算' : `${decimal(user.runway_days, 1)} 天`],
        ['近 7 天日均余额消费', user.daily_balance_cost == null ? '不可用' : `${money(user.daily_balance_cost)} 额度`],
        ['余额观察期', `${detail.recent.start} 至 ${detail.recent.end} · 所有平台`],
        ['最近观测使用', dateTime(detail.last_used_at, detail.timezone)],
        ['注册时间', dateTime(user.registered_at, detail.timezone)],
        ['用户状态', user.deleted ? '已删除或缺失' : statusNames[user.status] || user.status || '不可用'],
        ['快照时间', dateTime(detail.generatedAt, detail.timezone)]
      ];
      $('up-detail-state').innerHTML = stateRows.map(([key, value]) => `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`).join('');
    }
    async function openUser(id) {
      if (!base || !report || !isActive()) return;
      closeDetails();
      const token = detailGate.next(), query = { ...base };
      detailAbort = new AbortController();
      detailMetric = metric;
      $('up-detail-status').textContent = '正在读取用户用量与消费画像';
      $('up-detail-status').hidden = false;
      $('up-drawer').showModal();
      modalState();
      try {
        const nextDetail = await api(queryPath(`/api/user-profiles/users/${encodeURIComponent(id)}`, query), { signal: detailAbort.signal });
        if (!detailGate.current(token) || !isActive() || !$('up-drawer').open) return;
        detail = nextDetail;
        $('up-detail-status').hidden = true;
        $('up-detail-content').hidden = false;
        renderDetail();
        detailTab('preference');
      } catch (error) {
        if (!detailGate.current(token) || !isActive() || error.name === 'AbortError') return;
        $('up-detail-status').textContent = `读取失败：${error.message}`;
      }
    }
    async function exportUsers() {
      if (!base || !users || !isActive()) return;
      if ($('up-search-form').elements.search.value.trim() !== search) {
        search = $('up-search-form').elements.search.value.trim(); resetList();
        run(async () => { await loadUsers(); await exportUsers(); });
        return;
      }
      const query = listQuery(), token = usersGate.next();
      exportAbort?.abort();
      exportAbort = new AbortController();
      $('up-export').disabled = true;
      try {
        const csv = await api(queryPath('/api/user-profiles/export', query), { signal: exportAbort.signal });
        if (!usersGate.current(token) || !isActive()) return;
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = `user-profiles-${query.start}-${query.end}.csv`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`已导出当前筛选的 ${integer(users.pagination.total)} 位用户`);
      } catch (error) {
        if (error.name !== 'AbortError' && isActive()) toast(error.message, 'error');
      } finally {
        if (usersGate.current(token) && isActive()) $('up-export').disabled = !users?.pagination.total;
      }
    }
    function run(fn) {
      Promise.resolve().then(fn).catch((error) => { if (isActive() && error.name !== 'AbortError') {
        setConnection(false, '数据源异常'); toast(error.message, 'error');
      } });
    }
    function selectSegment(value) {
      segment = value; resetList();
      run(loadUsers);
    }
    $('up-filter').addEventListener('submit', (event) => { event.preventDefault(); resetList(); run(load); });
    $('up-filter').addEventListener('input', syncPresets);
    $('up-presets').addEventListener('click', (event) => {
      const button = event.target.closest('[data-days]');
      if (!button || !options) return;
      $('up-filter').elements.end.value = options.today;
      $('up-filter').elements.start.value = addDays(options.today, 1 - Number(button.dataset.days));
      resetList(); run(load);
    });
    $('up-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-metric]');
      if (!button || !report || metric === button.dataset.metric) return;
      metric = button.dataset.metric;
      renderPreferences(); resetList(); run(loadUsers);
    });
    $('up-segments').addEventListener('click', (event) => {
      const button = event.target.closest('[data-segment]');
      if (button && !button.disabled) selectSegment(button.dataset.segment);
    });
    $('up-attention-decline').addEventListener('click', () => selectSegment('decline'));
    $('up-attention-balance').addEventListener('click', () => selectSegment('balance'));
    function submitSearch() {
      search = $('up-search-form').elements.search.value.trim(); resetList(); run(loadUsers);
    }
    $('up-search-form').addEventListener('submit', (event) => { event.preventDefault(); submitSearch(); });
    $('up-search-form').elements.search.addEventListener('input', () => {
      clearTimeout(searchTimer); searchTimer = setTimeout(submitSearch, 300);
    });
    $('up-sort').addEventListener('change', (event) => { sort = event.target.value; resetList(); run(loadUsers); });
    $('up-page-size').addEventListener('change', (event) => { pageSize = Number(event.target.value); resetList(); run(loadUsers); });
    $('up-prev').addEventListener('click', () => { if (page > 1) { page--; run(loadUsers); } });
    $('up-next').addEventListener('click', () => { if (users?.pagination.hasNext) { page++; run(loadUsers); } });
    $('up-user-rows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-user]');
      if (button) run(() => openUser(button.dataset.user));
    });
    $('up-export').addEventListener('click', exportUsers);
    $('up-detail-close').addEventListener('click', closeDetails);
    $('up-drawer').addEventListener('close', () => {
      if ($('up-drawer').open) return;
      detailGate.invalidate(); detailAbort?.abort(); detail = null;
      $('up-detail-content').hidden = true; modalState();
    });
    $('up-detail-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-metric]');
      if (button) { detailMetric = button.dataset.metric; renderDetailPreferences(); }
    });
    $('up-detail-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (button) detailTab(button.dataset.tab);
    });
    $('up-detail-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'preference' : event.key === 'End' ? 'activity'
        : event.target.dataset.tab === 'preference' ? 'activity' : 'preference';
      detailTab(next); $(`up-${next}-tab`).focus();
    });
    $('up-definitions-open').addEventListener('click', () => { $('up-definitions').showModal(); modalState(); });
    $('up-definitions-close').addEventListener('click', () => { $('up-definitions').close(); });
    $('up-definitions').addEventListener('close', modalState);
    window.addEventListener('resize', () => { charts.forEach((instance) => instance.resize()); });

    function leave() {
      mainGate.invalidate(); usersGate.invalidate(); detailGate.invalidate();
      mainAbort?.abort(); usersAbort?.abort(); detailAbort?.abort(); exportAbort?.abort();
      clearTimeout(searchTimer);
      closeDetails();
      if ($('up-definitions').open) $('up-definitions').close();
      disposeCharts();
      modalState();
    }
    function reset() {
      leave();
      options = null; base = null; report = null; users = null;
      metric = 'requests'; segment = 'all'; sort = 'cost'; search = ''; page = 1; pageSize = 20;
      $('up-filter').reset(); $('up-search-form').reset(); $('up-sort').value = 'cost'; $('up-page-size').value = '20';
      $('up-data').hidden = true;
      for (const id of ['up-metrics', 'up-user-rows', 'up-detail-model-rows', 'up-detail-state']) $(id).innerHTML = '';
    }
    return { load, leave, reset };
  }

  const exported = { create, createRequestGate, dailyRows, platformName, platformColor, percent };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.UserProfilesUi = exported;
})(typeof window === 'undefined' ? globalThis : window);
