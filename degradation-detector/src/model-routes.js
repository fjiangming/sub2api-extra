'use strict';

const { channels, channelNames } = require('./model-config');
const { modelRunSummary, sanitizeModelResponse } = require('./model-results');
const { AppError } = require('./errors');

function installModelRoutes(app, runtime, { requireAuth, requireAdmin, requireCsrf, runLimiter, historyLimiter, discoverGroups, setNoStore }) {
  const missing = () => new AppError('MODEL_RESULT_NOT_FOUND', '模型检测结果不存在、未启用或无权访问', { status: 404 });
  const readableGroups = async req => {
    await runtime.auth.refreshUser(req.auth);
    return runtime.modelStore.visibleGroups(await discoverGroups(req, runtime));
  };
  const requireGroup = async (req, admin = false) => {
    const groups = admin ? await discoverGroups(req, runtime) : await readableGroups(req);
    const group = groups.find(item => String(item.id) === String(req.params.groupId));
    const stored = group && runtime.modelStore.group(group.id);
    if (!group || !stored || stored.platform !== group.platform) throw missing();
    if (req.params.channel && (!channels.includes(req.params.channel) || (!admin && !runtime.modelStore.effective(stored, req.params.channel).enabled))) throw missing();
    return group;
  };
  const validateChannels = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'channels')) throw new AppError('VALIDATION_ERROR', '模型检测请求参数无效', { status: 400 });
    if (body.channels == null) return channels;
    if (!Array.isArray(body.channels) || !body.channels.length || body.channels.length > 2 || body.channels.some(key => !channels.includes(key)) || new Set(body.channels).size !== body.channels.length) throw new AppError('VALIDATION_ERROR', '检测渠道选择无效', { status: 400 });
    return body.channels;
  };
  const handler = fn => async (req, res, next) => {
    try { setNoStore(res); await fn(req, res); } catch (error) { next(error); }
  };
  app.get('/api/model-results', requireAuth, handler(async (req, res) => {
    const groups = await readableGroups(req);
    const payload = groups.map(group => {
      const stored = runtime.modelStore.group(group.id);
      const config = runtime.modelStore.platform(group.platform);
      return {
        id: String(group.id), name: group.name, platform: group.platform,
        platform_label: runtime.store.getPlatformTest(group.platform, false)?.label || group.platform,
        next_run_at: stored.next_run_at == null ? null : stored.next_run_at / 1000,
        channels: Object.fromEntries(channels.filter(key => config.channels[key].enabled).map(key => [key, {
          name: channelNames[key], model: runtime.modelStore.effective(stored, key).model,
          site_url: new URL(config.channels[key].api_url).origin,
          latest: runtime.modelStore.latest(group.id, key), ...runtime.modelStore.counts(group.id, key)
        }]))
      };
    });
    const ids = [...new Set(payload.map(group => group.platform))];
    res.json({ groups: payload, platforms: ids.map(id => ({ id, label: payload.find(group => group.platform === id).platform_label })), schedule: runtime.modelStore.schedule(), schedule_timezone: runtime.config.scheduleTimezone, server_time: Date.now() / 1000 });
  }));
  const history = async (req, res, admin = false) => {
    const group = await requireGroup(req, admin);
    const before = req.query.before == null ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (!Number.isSafeInteger(before) || before < 1) throw new AppError('VALIDATION_ERROR', '历史记录游标无效', { status: 400 });
    const rows = runtime.modelStore.history(group.id, req.params.channel, before, 51);
    res.json({ runs: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null, ...runtime.modelStore.counts(group.id, req.params.channel) });
  };
  app.get('/api/model/groups/:groupId/channels/:channel/runs', requireAuth, handler(history));
  app.get('/api/admin/groups/:groupId/model-runs/:channel', requireAuth, requireAdmin, handler((req, res) => history(req, res, true)));
  const detail = async (req, res, admin = false) => {
    const id = Number(req.params.id);
    const run = Number.isSafeInteger(id) && id > 0 ? runtime.modelStore.run(id) : null;
    if (!run) throw missing();
    req.params.groupId = run.group_id;
    req.params.channel = run.channel;
    await requireGroup(req, admin);
    const response = run.response_json ? sanitizeModelResponse(JSON.parse(run.response_json)) : null;
    const config = JSON.parse(run.snapshot_json);
    res.json({ ...modelRunSummary(run), response, error_code: run.error_code || null,
      mode: { attribution_only: config.attribution_only === true, provider: config.provider === 'auto' ? config.platform === 'anthropic' ? 'claude' : 'codex' : config.provider || null } });
  };
  app.get('/api/model-results/:id', requireAuth, handler(detail));
  app.get('/api/admin/model-results/:id', requireAuth, requireAdmin, handler((req, res) => detail(req, res, true)));
  app.post('/api/admin/groups/:groupId/model-runs', requireAuth, requireAdmin, requireCsrf, runLimiter, handler(async (req, res) => {
    const group = await requireGroup(req, true);
    res.status(202).json({ runs: runtime.modelDetection.enqueue(String(group.id), 'manual', validateChannels(req.body)) });
  }));
  app.post('/api/admin/platforms/:platformId/model-runs', requireAuth, requireAdmin, requireCsrf, runLimiter, handler(async (req, res) => {
    const selected = validateChannels(req.body);
    const groups = (await discoverGroups(req, runtime)).filter(group => group.platform === req.params.platformId
      && runtime.modelStore.group(group.id)?.enabled && runtime.modelStore.group(group.id)?.platform === group.platform);
    if (!groups.length) throw missing();
    res.status(202).json({ runs: groups.flatMap(group => runtime.modelDetection.enqueue(String(group.id), 'manual', selected)) });
  }));
  app.delete('/api/admin/groups/:groupId/model-runs/:channel', requireAuth, requireAdmin, requireCsrf, historyLimiter, handler(async (req, res) => {
    const group = await requireGroup(req, true);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['all', 'ids'].includes(key))
      || (body.all === true ? body.ids != null : !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || body.ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw new AppError('VALIDATION_ERROR', '请选择最多 100 条记录，或明确清空该渠道历史', { status: 400 });
    const count = runtime.modelStore.deleteHistory(group.id, req.params.channel, body.all === true ? null : [...new Set(body.ids)]);
    if (count == null) throw new AppError('MODEL_HISTORY_CONFLICT', '所选记录不存在、属于其他分组或渠道，或仍在执行', { status: 409 });
    res.json({ deleted: count });
  }));
}

module.exports = { installModelRoutes };
