'use strict';

const { AppError } = require('./errors');
const { channels, names } = require('./provider-config');
const { runSummary } = require('./provider-results');
const { publicGroupCacheStats } = require('./group-metrics');

function installProviderRoutes(app, runtime, { requireAuth, requireAdmin, requireCsrf, runLimiter, configLimiter, historyLimiter, discoverGroups, setNoStore, previewHeaders, signedPreview, previewAncestors }) {
  const store = runtime.providerStore;
  const missing = () => new AppError('PROVIDER_RESULT_NOT_FOUND', '检测记录不存在、未启用或无权访问', { status: 404 });
  const invalid = message => new AppError('VALIDATION_ERROR', message, { status: 400 });
  const handler = fn => async (req, res, next) => {
    try { setNoStore(res); await fn(req, res); } catch (error) { next(error); }
  };
  const requireGroup = async (req, id, channel, admin = false) => {
    if (!channels.includes(channel)) throw missing();
    await runtime.auth.refreshUser(req.auth);
    const available = await discoverGroups(req, runtime);
    const group = available.find(group => String(group.id) === String(id));
    const stored = store.group(id, channel);
    if (!group || !stored || group.platform !== stored.platform || !admin && !store.enabled(stored)) throw missing();
    return group;
  };
  const adminPayload = async req => {
    const available = await discoverGroups(req, runtime);
    return {
      ...store.configuration(), timezone: runtime.config.scheduleTimezone, demo: runtime.config.demoMode, total_concurrency: runtime.config.concurrency,
      groups: available.map(group => ({
        id: String(group.id), name: group.name, platform: group.platform, rate_multiplier: group.rate_multiplier ?? null,
        configurations: Object.fromEntries(channels.map(channel => {
          const saved = store.group(group.id, channel);
          const usable = saved?.platform === group.platform ? saved : null;
          return [channel, {
            enabled: Boolean(usable?.enabled), key_configured: Boolean(usable?.key_cipher), override: usable?.override_json ? JSON.parse(usable.override_json) : null,
            key_reconfirm_required: Boolean(usable?.key_cipher && usable.key_destination !== store.destination(usable)),
            model: usable ? store.effective(usable).model : null,
            inherited_model: store.inheritedModel({ group_id: String(group.id), platform: group.platform }),
            next_run_at: usable?.next_run_at || null,
            latest: usable ? store.history(group.id, channel, Number.MAX_SAFE_INTEGER, 1)[0] || null : null,
            ...(usable ? store.counts(group.id, channel) : { total: 0, archived: 0, passed: 0, failed: 0 })
          }];
        }))
      }))
    };
  };
  app.get('/api/admin/provider-config', requireAuth, requireAdmin, handler(async (req, res) => res.json(await adminPayload(req))));
  app.put('/api/admin/provider-config', requireAuth, requireAdmin, requireCsrf, configLimiter, handler(async (req, res) => {
    const prepared = runtime.providerDetection.prepareConfiguration(req.body, await discoverGroups(req, runtime));
    if (!store.save(prepared.input, prepared.groups)) throw new AppError('PROVIDER_CONFIG_CONFLICT', '配置已更新，请刷新后重试', { status: 409 });
    runtime.providerDetection.configurationChanged();
    res.json(await adminPayload(req));
  }));
  app.get('/api/provider-results', requireAuth, handler(async (req, res) => {
    const channel = req.query.channel || 'candy';
    if (!channels.includes(channel)) throw invalid('未知检测类别');
    await runtime.auth.refreshUser(req.auth);
    const available = store.visible(await discoverGroups(req, runtime), channel);
    const metrics = available.length ? await runtime.groupMetrics.getRates([...new Set(store.groups().filter(group => store.enabled(group)).map(group => group.group_id))]) : null;
    const config = store.configuration();
    res.json({ channel, name: names[channel], server_time: Date.now(), timezone: runtime.config.scheduleTimezone, demo: runtime.config.demoMode,
      schedule: config.channels[channel].schedule,
      providers: Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { enabled: value.enabled }])),
      groups: available.map(group => {
        const saved = store.group(group.id, channel);
        const history = store.history(group.id, channel, Number.MAX_SAFE_INTEGER, 60);
        return { id: String(group.id), name: group.name, platform: group.platform, rate_multiplier: group.rate_multiplier ?? null,
          cache_stats: metrics ? publicGroupCacheStats(metrics, group.id) : null,
          model: store.effective(saved).model, next_run_at: saved.next_run_at,
          history, latest: history[0] || null, ...store.counts(group.id, channel) };
      })
    });
  }));
  const history = async (req, res, admin = false) => {
    await requireGroup(req, req.params.groupId, req.params.channel, admin);
    const before = req.query.before == null ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (!Number.isSafeInteger(before) || before < 1 || req.query.window && req.query.window !== '24h') throw invalid('历史游标或时间范围无效');
    const since = req.query.window === '24h' ? Date.now() - 86400000 : 0;
    const rows = store.history(req.params.groupId, req.params.channel, before, 51, since);
    res.json({ runs: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null, ...store.counts(req.params.groupId, req.params.channel) });
  };
  app.get('/api/provider/groups/:groupId/:channel/runs', requireAuth, handler(history));
  app.get('/api/admin/provider/groups/:groupId/:channel/runs', requireAuth, requireAdmin, handler((req, res) => history(req, res, true)));
  const requireRun = async (req, admin) => {
    const id = Number(req.params.id);
    const run = Number.isSafeInteger(id) && id > 0 ? store.run(id) : null;
    if (!run) throw missing();
    const group = await requireGroup(req, run.group_id, run.channel, admin);
    if (group.platform !== run.platform) throw missing();
    return run;
  };
  const detail = async (req, res, admin = false) => {
    const run = await requireRun(req, admin);
    const snapshot = JSON.parse(run.snapshot_json);
    const response = run.response_json ? JSON.parse(run.response_json) : null;
    const path = `${admin ? '/api/admin' : '/api'}/provider-results/${run.id}/preview`;
    res.json({ ...runSummary(run), response,
      settings: { model: run.model, protocol: snapshot.protocol || null, reasoning_effort: snapshot.reasoning_effort || null, service_tier: snapshot.service_tier || null, cache_test: snapshot.cache_test ?? null, thinking_test: snapshot.thinking_test ?? null },
      preview_url: response?.result?.html ? signedPreview(req, `provider-${run.id}`, path) : null });
  };
  const preview = async (req, res, admin = false) => {
    const run = await requireRun(req, admin);
    const html = run.response_json && JSON.parse(run.response_json).result?.html;
    if (!html) throw missing();
    previewHeaders(res, previewAncestors(req, `provider-${run.id}`));
    res.type('html').send(html);
  };
  app.get('/api/provider-results/:id', requireAuth, handler(detail));
  app.get('/api/admin/provider-results/:id', requireAuth, requireAdmin, handler((req, res) => detail(req, res, true)));
  app.get('/api/provider-results/:id/preview', requireAuth, handler(preview));
  app.get('/api/admin/provider-results/:id/preview', requireAuth, requireAdmin, handler((req, res) => preview(req, res, true)));
  app.post('/api/admin/provider/groups/:groupId/:channel/runs', requireAuth, requireAdmin, requireCsrf, runLimiter, handler(async (req, res) => {
    await requireGroup(req, req.params.groupId, req.params.channel, true);
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) throw invalid('手动检测无需其他参数');
    res.status(202).json({ run: runtime.providerDetection.enqueue(req.params.groupId, req.params.channel) });
  }));
  app.post('/api/admin/provider/:channel/runs', requireAuth, requireAdmin, requireCsrf, runLimiter, handler(async (req, res) => {
    if (!channels.includes(req.params.channel) || !req.body || Array.isArray(req.body) || Object.keys(req.body).length) throw invalid('批量检测请求无效');
    const groups = store.visible(await discoverGroups(req, runtime), req.params.channel);
    if (!groups.length) throw missing();
    res.status(202).json({ runs: runtime.store.db.transaction(() => groups.map(group => runtime.providerDetection.enqueue(group.id, req.params.channel)))() });
  }));
  app.delete('/api/admin/provider/groups/:groupId/:channel/runs', requireAuth, requireAdmin, requireCsrf, historyLimiter, handler(async (req, res) => {
    await requireGroup(req, req.params.groupId, req.params.channel, true);
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['all', 'ids'].includes(key)) || (body.all === true ? body.ids != null : body.all != null || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || body.ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw invalid('请指定全部历史，或最多 100 条记录');
    const count = store.deleteHistory(req.params.groupId, req.params.channel, body.all === true ? null : [...new Set(body.ids)]);
    if (count == null) throw new AppError('PROVIDER_HISTORY_CONFLICT', '所选记录不存在、属于其他分组，或仍在执行', { status: 409 });
    res.json({ deleted: count });
  }));
}

module.exports = { installProviderRoutes };
