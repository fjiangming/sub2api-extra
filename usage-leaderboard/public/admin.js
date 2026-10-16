'use strict';

window.UsageAdmin = (() => {
  const periods = { today: '今日', week: '本周', month: '本月', all: '累计' };
  const metrics = { tokens: 'Token 用量', requests: '调用次数' };
  const distributions = { natural: '自然梯度', close: '差距接近', concentrated: '头部集中' };
  const rangeInputs = ['minimum', 'maximum', 'board-minimum', 'board-maximum'];
  const root = () => document.getElementById('admin-content');
  const el = (id) => document.getElementById(`a-${id}`);
  const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (value) => new Intl.NumberFormat('en-US').format(value);
  const token = (value) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} <small>B</small>` : value >= 1e6 ? `${(value / 1e6).toFixed(2)} <small>M</small>` : num(value);
  let context;
  let snapshot;
  let initialized = false;
  let busy = false;
  let source = 'simulation';
  let period = 'month';
  let metric = 'tokens';
  let preview = null;
  let sequence = 0;
  let controller;
  let pendingAction;

  function rules() {
    const minimum = Number(el('minimum').value);
    const maximum = Number(el('maximum').value);
    const boardMinimum = Number(el('board-minimum').value);
    const boardMaximum = Number(el('board-maximum').value);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 1 || maximum > 1000 || maximum <= minimum) return null;
    if (!Number.isFinite(boardMinimum) || !Number.isFinite(boardMaximum) || boardMinimum < 1 || boardMaximum > 1000 || boardMaximum <= boardMinimum || Math.min(maximum, boardMaximum) <= Math.max(minimum, boardMinimum)) return null;
    return { minimumTokens: Math.round(minimum * 1e6), maximumTokens: Math.round(maximum * 1e6), distribution: el('distribution').value,
      boardMinimumTokens: Math.round(boardMinimum * 1e6), boardMaximumTokens: Math.round(boardMaximum * 1e6) };
  }
  function changedRules() {
    return source === 'simulation' && JSON.stringify(rules()) !== JSON.stringify(snapshot?.draft?.candidate?.rules);
  }
  function date(value) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: snapshot.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }
  function candidateExpired() {
    return snapshot?.draftExpired === true;
  }
  function controls() {
    if (!initialized) return;
    root().querySelectorAll('button, input, select').forEach((control) => { control.disabled = busy; });
    el('fields').disabled = busy || source !== 'simulation';
    el('restore').disabled = busy || snapshot?.published?.source !== 'simulation';
    el('rollback').disabled = busy || !snapshot?.previous || snapshot.previous.expired;
    const ready = source === 'real' || Boolean(snapshot?.draft?.candidate && !changedRules() && !candidateExpired());
    el('save').disabled = busy || !ready;
    el('publish').disabled = busy || !ready || !preview;
    el('draft-state').textContent = busy ? '正在处理' : !ready ? candidateExpired() ? '候选已过期，请重新生成' : '生成参数待应用' : source === 'real' ? '真实用量草稿' : '候选数据待发布';
    for (const button of root().querySelectorAll('[data-source]')) button.setAttribute('aria-pressed', String(button.dataset.source === source));
  }
  function applySnapshot(data, { syncRules = true } = {}) {
    snapshot = data;
    const publication = data.published;
    const mode = publication?.source === 'simulation' && !data.expired ? '模拟补位已开启' : '真实用量';
    el('published-mode').innerHTML = '<span class="status-dot"></span>' + mode;
    el('published-version').textContent = publication ? publication.version.slice(0, 8) : '默认版本';
    el('published-at').textContent = publication ? `${date(publication.publishedAt)} · ${publication.actor}` : '尚未发布';
    el('storage').textContent = data.persistence ? '设置文件 ≤ 64 KiB' : '内存模式 · 重启恢复默认';
    el('candidate-version').textContent = `修订 ${data.revision}`;
    const messages = [data.storageError, data.expired ? '已发布模拟数据跨天失效，用户端已自动恢复真实榜单。' : '',
      publication?.candidate?.version < 4 && !data.expired ? '当前为固定模拟快照，自动增长与跨天续接需重新生成并发布后生效。' : '',
      !data.persistence ? '当前为内存模式，容器重启后草稿和发布设置会清空。' : ''].filter(Boolean);
    el('notice').hidden = !messages.length;
    el('notice').textContent = messages.join(' ');
    const candidate = data.draft?.candidate;
    el('valid-date').textContent = candidate ? candidate.version === 4 ? '自动跨天续接' : candidate.date : '尚未生成';
    if (syncRules) {
      const values = { ...data.defaults, ...candidate?.rules };
      el('minimum').value = values.minimumTokens / 1e6;
      el('maximum').value = values.maximumTokens / 1e6;
      el('board-minimum').value = values.boardMinimumTokens / 1e6;
      el('board-maximum').value = values.boardMaximumTokens / 1e6;
      el('distribution').value = values.distribution;
    }
    controls();
  }
  function status(message, retry = false) {
    el('preview-status').hidden = false;
    el('preview-status').textContent = message;
    el('preview-content').hidden = true;
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary-action'; button.textContent = '重新加载';
      button.addEventListener('click', () => loadPreview());
      el('preview-status').append(button);
    }
  }
  async function handleError(error) {
    if (['AbortError'].includes(error.name)) return;
    const message = error.name === 'TimeoutError' ? '请求超时，请重试' : error.message;
    context.notify(message);
    if ([401, 403].includes(error.status)) {
      root().replaceChildren(); initialized = false; snapshot = null; preview = null;
      context.onDenied(error);
    } else if (error.code === 'SIMULATION_HISTORY_CONFLICT') {
      el('range-error').textContent = error.message;
      el('range-error').hidden = false;
    } else if (error.status === 409 || error.code === 'SIMULATION_EXPIRED') {
      const data = await context.api('admin/settings').catch(() => null);
      if (data) { applySnapshot(data); await loadPreview(); }
    }
  }
  function renderPreview(data) {
    const mixed = data.display.simulatedCount > 0;
    const scoped = data.display.mode !== 'real';
    const bounded = data.display.rangeApplied === true;
    const ordered = [metric, metric === 'tokens' ? 'requests' : 'tokens'];
    const format = (value, type) => type === 'tokens' ? token(value) : num(value);
    el('preview-subtitle').textContent = source === 'real' ? '真实用量' : bounded ? '真实无上限 · 按用量混排' : mixed ? '真实优先 · 模拟补位' : '真实用户已占满 10 位';
    el('total-label').textContent = scoped ? '榜单 Token 用量' : '全站 Token 用量';
    el('count-label').textContent = scoped ? '上榜用户' : '活跃创造者';
    el('requests-label').textContent = scoped ? '榜单调用次数' : '全站调用次数';
    el('total').innerHTML = token(data.summary.tokens);
    el('count').innerHTML = `${num(data.summary.active)} <small>位</small>`;
    el('requests').textContent = num(data.summary.requests);
    el('primary-heading').textContent = metrics[ordered[0]];
    el('secondary-heading').textContent = metrics[ordered[1]];
    el('source-counts').textContent = `真实 ${data.display.realCount} · 模拟 ${data.display.simulatedCount}`;
    el('caption').textContent = `${periods[period]}按${metrics[metric]}排序的候选前十位`;
    el('preview-body').innerHTML = data.entries.map((user, i) => `<tr><td><span class="${i < 3 ? `rank-medal medal-${i + 1}` : 'rank-number'}">${String(user.rank).padStart(2, '0')}</span></td><td><div class="identity">${window.UsageAvatars.html(user, 28)}<span title="${escape(user.name)}">${escape(user.name)}</span>${user.source === 'simulation' ? '<b class="example-tag">示例</b>' : '<b class="small-badge">真实</b>'}</div></td><td class="right token-cell" title="${num(user[ordered[0]])}">${format(user[ordered[0]], ordered[0])}</td><td class="right secondary-metric">${format(user[ordered[1]], ordered[1])}</td></tr>`).join('');
    if (!data.entries.length) el('preview-body').innerHTML = '<tr><td colspan="4">这个周期还没有用量记录</td></tr>';
    el('snapshot-date').textContent = mixed ? data.display.dynamic ? `示例更新于 ${date(data.display.snapshotAt)}` : `模拟快照 ${data.display.date}` : `更新于 ${date(data.generatedAt)}`;
    const values = data.entries.map((row) => row.tokens).sort((a, b) => b - a);
    const maximum = Math.max(1, ...values);
    el('distribution-chart').innerHTML = values.map((value) => `<span style="height:${Math.max(2, value / maximum * 100)}%"></span>`).join('');
    el('source-meta').textContent = source === 'real' ? '按主站实际用量排名' : '真实达下限 · 示例补位';
    el('preview-status').hidden = true;
    el('preview-content').hidden = false;
    icons();
  }
  async function loadPreview() {
    const current = ++sequence;
    controller?.abort();
    controller = new AbortController();
    preview = null;
    controls();
    if (source === 'simulation' && (!snapshot?.draft?.candidate || changedRules() || candidateExpired())) {
      status(candidateExpired() ? '候选数据已跨天，请重新生成' : '请应用生成规则，生成新的候选榜单');
      return;
    }
    status('正在读取真实用量并合并候选榜单');
    try {
      const data = await context.api(`admin/leaderboard/preview?${new URLSearchParams({ period, metric, source })}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
      if (current !== sequence) return;
      preview = data;
      renderPreview(data);
    } catch (error) {
      if (current !== sequence) return;
      status(error.name === 'TimeoutError' ? '读取超时，请重试' : error.message, true);
      await handleError(error);
    } finally { if (current === sequence) controls(); }
  }
  async function mutate(path, body, { method = 'POST', message, nextSource } = {}) {
    if (busy) return;
    busy = true; controls();
    try {
      const data = await context.api(`admin/${path}`, { method, body: JSON.stringify({ revision: snapshot.revision, ...body }) });
      if (nextSource) source = nextSource;
      applySnapshot(data);
      await loadPreview();
      if (message) context.notify(message);
    } catch (error) { await handleError(error); }
    finally { busy = false; controls(); }
  }
  function confirm(action) {
    if (busy) return;
    const titles = { publish: source === 'simulation' ? '发布模拟混合榜单' : '发布真实榜单', 'restore-real': '恢复真实榜单', rollback: '回退上一发布版本' };
    pendingAction = { action, revision: snapshot.revision, source };
    el('dialog-title').textContent = titles[action];
    const details = action === 'publish' ? [
      ['数据来源', source === 'simulation' ? '达到下限的真实用户，示例补齐' : '主站真实用量'],
      ...(source === 'simulation' ? [['真实用户 Token', `至少 ${el('board-minimum').value}M，无上限`], ['榜单模拟 Token', `${el('board-minimum').value}M ~ ${el('board-maximum').value}M`], ['单人模拟 Token', `${el('minimum').value}M ~ ${el('maximum').value}M`], ['展示顺序', '按当前用量指标混排'], ['数值分布', distributions[el('distribution').value]], ['更新方式', snapshot.draft.candidate.version === 4 ? '每 5 分钟增长 · 自动跨天续接' : '固定快照'] ] : []),
      ['个人统计', '始终使用实际用量'], ['存储方式', snapshot.persistence ? '覆盖固定设置文件' : '内存，重启后恢复默认']
    ] : action === 'rollback' ? [['目标来源', snapshot.previous.source === 'real' ? '真实用量' : '模拟混合榜单'], ['目标版本', snapshot.previous.version.slice(0, 8)]] : [['数据来源', '主站真实用量'], ['生效范围', '所有统计周期']];
    el('publish-summary').innerHTML = details.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
    const command = action === 'restore-real' ? '确认恢复' : action === 'rollback' ? '确认回退' : '确认发布';
    el('confirm').innerHTML = `<i data-lucide="check"></i>${command}`;
    icons();
    el('dialog').showModal();
  }
  function bind() {
    root().querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => {
      if (source === button.dataset.source) return;
      source = button.dataset.source; controls(); loadPreview();
    }));
    root().querySelectorAll('[data-preview-period]').forEach((button) => button.addEventListener('click', () => {
      period = button.dataset.previewPeriod;
      root().querySelectorAll('[data-preview-period]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      loadPreview();
    }));
    el('metric').addEventListener('change', () => { metric = el('metric').value; loadPreview(); });
    [...rangeInputs, 'distribution'].forEach((id) => el(id).addEventListener('input', () => {
      el('range-error').hidden = true;
      rangeInputs.forEach((id) => el(id).removeAttribute('aria-invalid'));
      controls(); loadPreview();
    }));
    el('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const values = rules();
      if (!values) {
        el('range-error').textContent = '两个范围均须为 1M~1000M，上限须大于下限，且单人模拟范围与榜单范围须有交集'; el('range-error').hidden = false;
        rangeInputs.forEach((id) => el(id).setAttribute('aria-invalid', 'true')); el('board-minimum').focus();
        return;
      }
      el('range-error').hidden = true;
      mutate('simulation/preview', { rules: values, keepIdentities: el('keep-identities').checked }, { message: '候选已生成，尚未影响用户端' });
    });
    el('reset').addEventListener('click', () => {
      el('minimum').value = snapshot.defaults.minimumTokens / 1e6;
      el('maximum').value = snapshot.defaults.maximumTokens / 1e6;
      el('board-minimum').value = snapshot.defaults.boardMinimumTokens / 1e6;
      el('board-maximum').value = snapshot.defaults.boardMaximumTokens / 1e6;
      el('distribution').value = snapshot.defaults.distribution;
      el('range-error').hidden = true;
      controls(); loadPreview();
    });
    el('save').addEventListener('click', () => mutate('settings/draft', { source }, { method: 'PUT', message: snapshot.persistence ? '草稿已保存，用户端保持当前版本' : '草稿已保存在内存中' }));
    el('publish').addEventListener('click', () => confirm('publish'));
    el('restore').addEventListener('click', () => confirm('restore-real'));
    el('rollback').addEventListener('click', () => confirm('rollback'));
    root().querySelectorAll('[data-admin-close]').forEach((button) => button.addEventListener('click', () => el('dialog').close()));
    el('confirm').addEventListener('click', () => {
      const pending = pendingAction;
      el('dialog').close();
      if (!pending) return;
      mutate(`leaderboard/${pending.action}`, { revision: pending.revision, ...(pending.action === 'publish' ? { source: pending.source } : {}) }, { message: '榜单设置已生效', nextSource: pending.action === 'restore-real' ? 'real' : undefined });
    });
  }
  async function show() {
    const loading = document.getElementById('admin-loading');
    loading.hidden = false; loading.textContent = '正在验证管理员身份';
    root().hidden = true;
    try {
      if (!initialized) {
        const view = await context.api('admin/view');
        root().innerHTML = view.html;
        initialized = true; bind();
      }
      const data = await context.api('admin/settings');
      source = data.draft?.source || data.published?.source || 'simulation';
      applySnapshot(data);
      root().hidden = false; loading.hidden = true;
      await loadPreview(); icons();
    } catch (error) {
      loading.textContent = error.message;
      if (![401, 403].includes(error.status)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary-action'; retry.textContent = '重新加载';
        retry.addEventListener('click', () => show()); loading.append(retry);
      }
      await handleError(error);
    }
  }
  function hide() { controller?.abort(); sequence++; el('dialog')?.close(); }
  return { configure(options) { context = options; }, show, hide, clear() {
    hide(); initialized = false; snapshot = null; preview = null; root().replaceChildren();
  } };
})();
