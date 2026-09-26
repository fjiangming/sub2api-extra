'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { AuthService, isAdminUser } = require('./auth');
const { defaultPlatformTest, loadConfig, validateAdminConfiguration } = require('./config');
const { CredentialVault } = require('./credential-vault');
const { DetectionRunner } = require('./detection-runner');
const { AppError, publicError } = require('./errors');
const { Scheduler } = require('./scheduler');
const { Store, publicRun } = require('./store');
const { Sub2ApiClient } = require('./sub2api-client');

const PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'"
].join('; ');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function demoGroups() {
  return [
    { id: '8', name: 'GPT｜不降智｜官Key', platform: 'openai', status: 'active', rate_multiplier: 1 },
    { id: '2', name: 'Claude｜企业', platform: 'anthropic', status: 'active', rate_multiplier: 0.8 },
    { id: '40', name: 'Gemini｜专属定制', platform: 'gemini', status: 'active', rate_multiplier: 0.6 },
    { id: '34', name: '未支持平台', platform: 'other', status: 'active', rate_multiplier: 1 }
  ];
}

function platformGroups(groups, runtime) {
  const enabled = new Map(runtime.store.listEnabledMonitors(runtime.config.serviceOwnerId)
    .map((monitor) => [String(monitor.group_id), monitor]));
  return groups.filter((group) => {
    const monitor = enabled.get(String(group.id));
    return monitor && monitor.platform === group.platform;
  });
}

function groupPayload(group, summary, runtime) {
  const test = runtime.store.getPlatformTest(group.platform);
  const monitor = summary.monitor;
  return {
    id: group.id,
    name: group.name,
    platform: group.platform,
    platform_label: test?.label || group.platform,
    model: test?.model || null,
    output_type: test?.output_type || null,
    next_run_at: monitor?.next_run_at == null ? null : monitor.next_run_at / 1000,
    totals: summary.totals,
    history: summary.history
  };
}

async function discoverGroups(req, runtime) {
  return runtime.config.demoMode
    ? demoGroups()
    : await runtime.sub2api.listAvailableGroups(req.auth.upstreamToken);
}

async function availableGroups(req, runtime) {
  return platformGroups(await discoverGroups(req, runtime), runtime);
}

async function requireGroup(req, runtime) {
  const groups = await availableGroups(req, runtime);
  const group = groups.find((item) => String(item.id) === String(req.params.groupId));
  if (!group) {
    throw new AppError('GROUP_NOT_AVAILABLE', '该分组不存在、无权访问或平台未启用检测', { status: 404 });
  }
  return group;
}

function requireConfiguredMonitor(group, runtime) {
  const monitor = runtime.store.getEnabledMonitor(runtime.config.serviceOwnerId, group.id);
  if (!monitor) {
    throw new AppError(
      'DETECTION_KEY_NOT_CONFIGURED',
      `分组 ${group.name} 未启用检测或未配置服务专用 Key`,
      { status: 409 }
    );
  }
  if (!runtime.config.demoMode) runtime.vault.decrypt(group.id, monitor.key_cipher);
  return monitor;
}

async function canAccessRun(req, runtime, run) {
  if (!run || String(run.user_id) !== runtime.config.serviceOwnerId) return false;
  const groups = await availableGroups(req, runtime);
  return groups.some((group) => String(group.id) === String(run.group_id));
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function previewHeaders(res) {
  setNoStore(res);
  res.setHeader('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function artifactMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

function safeArtifactPath(config, filename) {
  if (!filename) return null;
  const root = path.resolve(config.artifactDir);
  const resolved = path.resolve(filename);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function publicTest(test) {
  if (!test) return null;
  const { platform: _platform, ...payload } = test;
  return payload;
}

function credentialUsable(runtime, monitor) {
  if (!monitor?.key_cipher || !monitor?.key_fingerprint) return false;
  if (runtime.config.demoMode) return true;
  try {
    runtime.vault.decrypt(monitor.group_id, monitor.key_cipher);
    return true;
  } catch {
    return false;
  }
}

async function adminConfigurationPayload(req, runtime) {
  const discovered = (await discoverGroups(req, runtime))
    .filter((group) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(group.platform))
    .filter((group) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(String(group.id)));
  const storedPlatforms = new Map(runtime.store.listPlatformConfigs()
    .map((platform) => [platform.platform, platform]));
  const monitors = new Map(runtime.store.listMonitors(runtime.config.serviceOwnerId)
    .map((monitor) => [String(monitor.group_id), monitor]));
  const grouped = new Map();
  for (const group of discovered) {
    if (!grouped.has(group.platform)) grouped.set(group.platform, []);
    grouped.get(group.platform).push(group);
  }
  const platforms = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, groups]) => {
      const stored = storedPlatforms.get(id);
      const test = stored?.test || { ...defaultPlatformTest(id), platform: id };
      return {
        id,
        label: test.label || id,
        enabled: Boolean(stored?.enabled && stored?.test),
        test: publicTest(test),
        groups: groups
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
          .map((group) => {
            const monitor = monitors.get(String(group.id));
            const keyConfigured = credentialUsable(runtime, monitor);
            return {
              id: String(group.id),
              name: group.name,
              status: group.status,
              rate_multiplier: group.rate_multiplier ?? null,
              enabled: Boolean(stored?.enabled && monitor?.enabled && keyConfigured),
              key_configured: keyConfigured
            };
          })
      };
    });
  const settings = runtime.store.getServiceSettings();
  return {
    schedule_time: settings.schedule_times[0],
    schedule_mode: settings.schedule_mode,
    schedule_times: settings.schedule_times,
    schedule_interval_minutes: settings.schedule_interval_minutes,
    schedule_timezone: settings.schedule_timezone,
    updated_at: settings.updated_at / 1000,
    platforms
  };
}

async function saveAdminConfiguration(req, runtime) {
  let submitted;
  try {
    submitted = validateAdminConfiguration(req.body);
  } catch (error) {
    throw new AppError('VALIDATION_ERROR', error.message, { status: 400 });
  }
  const discovered = await discoverGroups(req, runtime);
  const availablePlatforms = new Map();
  const availableGroups = new Map();
  for (const group of discovered) {
    if (!availablePlatforms.has(group.platform)) availablePlatforms.set(group.platform, []);
    availablePlatforms.get(group.platform).push(group);
    availableGroups.set(String(group.id), group);
  }

  const fingerprints = new Set();
  const selectedGroups = [];
  for (const platform of submitted.platforms) {
    if (!availablePlatforms.has(platform.id)) {
      throw new AppError('PLATFORM_NOT_AVAILABLE', `平台 ${platform.id} 不存在或当前管理员无权配置`, { status: 400 });
    }
    for (const selection of platform.groups) {
      const group = availableGroups.get(String(selection.id));
      if (!group || group.platform !== platform.id) {
        throw new AppError('GROUP_NOT_AVAILABLE', '分组不存在、无权配置或平台不匹配', { status: 400 });
      }
      const submittedKey = String(selection.key || '').trim();
      if (!selection.enabled) {
        if (submittedKey) {
          throw new AppError('VALIDATION_ERROR', '未启用的分组不能提交专用 Key', { status: 400 });
        }
        continue;
      }
      const existing = runtime.store.getMonitor(runtime.config.serviceOwnerId, group.id);
      let keyCipher;
      let keyFingerprint;
      if (submittedKey) {
        keyCipher = runtime.vault.encrypt(group.id, submittedKey);
        keyFingerprint = runtime.vault.fingerprint(submittedKey);
      } else if (credentialUsable(runtime, existing)) {
        keyCipher = existing.key_cipher;
        keyFingerprint = existing.key_fingerprint;
      } else {
        throw new AppError(
          'DETECTION_KEY_REQUIRED',
          `分组 ${group.name} 必须填写完整的专用 Key`,
          { status: 400 }
        );
      }
      if (fingerprints.has(keyFingerprint)) {
        throw new AppError('DETECTION_KEY_DUPLICATED', '不同分组不能重复使用同一个专用 Key', { status: 400 });
      }
      fingerprints.add(keyFingerprint);
      selectedGroups.push({
        id: String(group.id),
        name: group.name,
        platform: group.platform,
        keyCipher,
        keyFingerprint
      });
    }
  }

  runtime.store.saveAdminConfiguration({
    scheduleMode: submitted.schedule_mode,
    scheduleTimes: submitted.schedule_times,
    scheduleIntervalMinutes: submitted.schedule_interval_minutes,
    scheduleTimezone: runtime.config.scheduleTimezone,
    updatedBy: String(req.auth.user.id),
    serviceOwnerId: runtime.config.serviceOwnerId,
    platforms: submitted.platforms,
    groups: selectedGroups
  });
  return adminConfigurationPayload(req, runtime);
}

function seedDemo(config, store, vault) {
  if (!config.demoMode) return;
  const userId = config.serviceOwnerId;
  const seed = [
    ['8', 'GPT｜不降智｜官Key', 'openai', 'normal'],
    ['2', 'Claude｜企业', 'anthropic', 'normal'],
    ['40', 'Gemini｜专属定制', 'gemini', 'degraded']
  ];
  store.saveAdminConfiguration({
    scheduleMode: 'daily',
    scheduleTimes: ['09:00', '18:00'],
    scheduleIntervalMinutes: 60,
    scheduleTimezone: config.scheduleTimezone,
    updatedBy: 'demo-user',
    serviceOwnerId: userId,
    platforms: [...new Set(seed.map((item) => item[2]))].map((platform) => ({
      id: platform,
      enabled: true,
      test: { ...defaultPlatformTest(platform), platform },
      groups: []
    })),
    groups: seed.map(([groupId, groupName, platform]) => {
      const key = `demo-dedicated-key-${groupId}-1234567890`;
      return {
        id: groupId,
        name: groupName,
        platform,
        keyCipher: vault.encrypt(groupId, key),
        keyFingerprint: vault.fingerprint(key)
      };
    })
  });
  for (const [groupId, groupName, platform, status] of seed) {
    const monitor = store.getMonitor(userId, groupId);
    const test = store.getPlatformTest(platform);
    if (!test || store.listHistory(userId, groupId, 1).length > 0) continue;
    const run = store.createRun(monitor, test, 'demo');
    store.markRunRunning(run.id);
    const isHtml = test.output_type === 'html';
    const html = isHtml ? `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#bfe9f4;font-family:system-ui}
      .road{position:absolute;inset:70% 0 0;background:#374b59}.bird{position:relative;font-size:88px;animation:ride 1.2s ease-in-out infinite}
      .bike{font-size:120px;margin-top:-30px}@keyframes ride{50%{transform:translateY(-8px)}}
    </style></head><body><div class="road"></div><main><div class="bird">🦤</div><div class="bike">🚲</div></main></body></html>` : '1161';
    store.completeRun(run.id, {
      status,
      quality: status,
      reason: status === 'normal'
        ? '规则判定为正常；单次结果不能证明模型身份或整体能力'
        : '规则判定为疑似降智：缺少预期细节；单次结果不能证明模型身份或整体能力',
      source: 'demo_fixture',
      outputText: html,
      artifactMime: isHtml ? 'text/html' : 'text/plain',
      previewToken: isHtml ? `demo-service-${groupId}-preview-token` : null
    }, store.nextScheduledAt());
  }
}

function createRuntime(config, overrides = {}) {
  const store = overrides.store || new Store(config);
  store.prepareServiceOwnership?.(config.serviceOwnerId);
  const vault = overrides.vault || new CredentialVault(config);
  const sub2api = overrides.sub2api || new Sub2ApiClient(config, overrides.fetchImpl);
  const auth = overrides.auth || new AuthService(config, sub2api);
  const runner = overrides.runner || new DetectionRunner({
    config,
    store,
    sub2api,
    vault
  });
  const scheduler = overrides.scheduler || new Scheduler({ config, store, runner });
  return { config, store, vault, sub2api, auth, runner, scheduler };
}

function createApp(config, overrides = {}) {
  const runtime = overrides.runtime || createRuntime(config, overrides);
  seedDemo(config, runtime.store, runtime.vault);
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ['*']
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: '512kb' }));

  const authLimiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const runLimiter = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const configLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const requireAuth = runtime.auth.middleware();
  const requireAdmin = runtime.auth.adminMiddleware();
  const requireCsrf = runtime.auth.csrfMiddleware();

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const publicRoot = path.join(config.projectRoot, 'public');
  const adminRoot = path.join(config.projectRoot, 'admin');
  const sendPublicFile = (filename) => (_req, res) => {
    setNoStore(res);
    res.sendFile(path.join(publicRoot, filename));
  };
  const sendAdminFile = (filename) => (_req, res) => {
    setNoStore(res);
    res.sendFile(path.join(adminRoot, filename));
  };

  app.get(['/', '/results', '/results/'], sendPublicFile('index.html'));

  const establishAdminEntrySession = async (req, res, next) => {
    const accessToken = String(req.query.token || req.query.access_token || '').trim();
    const demo = String(req.query.demo || '').trim();
    if (!accessToken && !demo) return next();
    setNoStore(res);
    try {
      if (accessToken) {
        if (accessToken.length > 16384) {
          throw new AppError('AUTH_REQUIRED', '缺少有效的 Sub2API 登录令牌', { status: 401 });
        }
        const user = await runtime.sub2api.verifyUser(accessToken);
        if (!isAdminUser(user)) {
          throw new AppError('ADMIN_REQUIRED', '只有 Sub2API 管理员可以访问检测管理页面', { status: 403 });
        }
        runtime.auth.createSession(req, res, user, accessToken, 'sso');
      } else {
        if (demo !== '1') {
          throw new AppError('ADMIN_REQUIRED', '只有 Sub2API 管理员可以访问检测管理页面', { status: 403 });
        }
        runtime.auth.demo(req, res, false);
      }
      const theme = ['dark', 'light'].includes(String(req.query.theme || ''))
        ? `?theme=${encodeURIComponent(String(req.query.theme))}`
        : '';
      return res.redirect(303, `/admin/config${theme}`);
    } catch (error) {
      return next(error);
    }
  };

  app.get(
    ['/admin/config', '/admin/config/'],
    authLimiter,
    establishAdminEntrySession,
    requireAuth,
    requireAdmin,
    sendAdminFile('index.html')
  );
  app.get('/admin/config.js', requireAuth, requireAdmin, sendAdminFile('app.js'));
  app.get('/admin/config.css', requireAuth, requireAdmin, sendAdminFile('styles.css'));

  app.get('/api/previews/:token', requireAuth, async (req, res, next) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[a-zA-Z0-9_-]{20,100}$/.test(token)) throw new AppError('PREVIEW_NOT_FOUND', '预览不存在', { status: 404 });
      const run = runtime.store.getRunByPreviewToken(token);
      if (!await canAccessRun(req, runtime, run)) {
        throw new AppError('PREVIEW_NOT_FOUND', '预览不存在或已过期', { status: 404 });
      }
      previewHeaders(res);
      if (run.output_type === 'html' && run.output_text) {
        res.type('html').send(run.output_text);
        return;
      }
      const artifactPath = safeArtifactPath(config, run.artifact_path);
      if (!artifactPath || !fs.existsSync(artifactPath)) {
        throw new AppError('PREVIEW_NOT_FOUND', '预览文件不存在或已过期', { status: 404 });
      }
      const mime = artifactMime(run.artifact_mime);
      if (mime.startsWith('image/')) {
        const title = escapeHtml(run.artifact_name || '检测图片');
        res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#f8fafc}body{display:grid;place-items:center;padding:12px}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img src="/api/artifacts/${encodeURIComponent(token)}" alt="${title}"></body></html>`);
        return;
      }
      if (mime === 'application/pdf') {
        res.setHeader('Content-Type', mime);
        const filename = encodeURIComponent(run.artifact_name || `result-${run.id}.pdf`);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filename}`);
        res.sendFile(artifactPath);
        return;
      }
      if (mime.startsWith('audio/') || mime.startsWith('video/')) {
        const title = escapeHtml(run.artifact_name || '检测媒体');
        const element = mime.startsWith('audio/') ? 'audio' : 'video';
        res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#f8fafc}body{display:grid;place-items:center;padding:12px}${element}{display:block;max-width:100%;max-height:100%}</style></head><body><${element} src="/api/artifacts/${encodeURIComponent(token)}" controls></${element}></body></html>`);
        return;
      }
      if (mime.startsWith('text/') || mime === 'application/json') {
        const text = fs.readFileSync(artifactPath, 'utf8');
        res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:#f8fafc;color:#172133}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:20px;font:13px/1.6 ui-monospace,monospace}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`);
        return;
      }
      res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:14px system-ui;background:#f8fafc;color:#334155}a{color:#0f766e}</style></head><body><a href="/api/artifacts/${encodeURIComponent(token)}?download=1">下载 ${escapeHtml(run.artifact_name || '检测产物')}</a></body></html>`);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/artifacts/:token', requireAuth, async (req, res, next) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[a-zA-Z0-9_-]{20,100}$/.test(token)) {
        throw new AppError('ARTIFACT_NOT_FOUND', '检测产物不存在或已过期', { status: 404 });
      }
      const run = runtime.store.getRunByPreviewToken(token);
      if (!await canAccessRun(req, runtime, run)) {
        throw new AppError('ARTIFACT_NOT_FOUND', '检测产物不存在或已过期', { status: 404 });
      }
      const artifactPath = safeArtifactPath(config, run?.artifact_path);
      if (!run || !artifactPath || !fs.existsSync(artifactPath)) {
        throw new AppError('ARTIFACT_NOT_FOUND', '检测产物不存在或已过期', { status: 404 });
      }
      previewHeaders(res);
      res.setHeader('Content-Type', artifactMime(run.artifact_mime));
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      const filename = encodeURIComponent(run.artifact_name || `result-${run.id}`);
      res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${filename}`);
      res.sendFile(artifactPath);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/sso', authLimiter, async (req, res, next) => {
    try {
      setNoStore(res);
      res.json(await runtime.auth.sso(req, res, bearerToken(req)));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/demo', authLimiter, (req, res, next) => {
    try {
      setNoStore(res);
      res.json(runtime.auth.demo(req, res, req.body?.readOnly === true));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', requireAuth, async (req, res, next) => {
    try {
      await runtime.auth.refreshUser(req.auth);
      setNoStore(res);
      res.json(runtime.auth.publicSession(req.auth));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/auth/session', requireAuth, requireCsrf, (req, res) => {
    runtime.auth.logout(req, res);
    res.status(204).end();
  });

  app.get('/api/admin/config', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      setNoStore(res);
      res.json(await adminConfigurationPayload(req, runtime));
    } catch (error) {
      next(error);
    }
  });

  app.put(
    '/api/admin/config',
    requireAuth,
    requireAdmin,
    requireCsrf,
    configLimiter,
    async (req, res, next) => {
      try {
        setNoStore(res);
        res.json(await saveAdminConfiguration(req, runtime));
      } catch (error) {
        next(error);
      }
    }
  );

  app.get('/api/results', requireAuth, async (req, res, next) => {
    try {
      setNoStore(res);
      await runtime.auth.refreshUser(req.auth);
      const groups = await availableGroups(req, runtime);
      const payload = groups.map((group) => groupPayload(
        group,
        runtime.store.groupSummary(config.serviceOwnerId, group.id, config.listHistoryLimit),
        runtime
      ));
      const nextRunTimes = payload.map((group) => group.next_run_at).filter(Number.isFinite);
      const nextRunAt = nextRunTimes.length > 0 ? Math.min(...nextRunTimes) : null;
      const platformIds = [...new Set(payload.map((group) => group.platform))];
      const settings = runtime.store.getServiceSettings();
      res.json({
        groups: payload,
        platforms: platformIds.map((platform) => ({
          id: platform,
          label: runtime.store.getPlatformTest(platform)?.label || platform
        })),
        schedule_time: settings.schedule_times[0],
        schedule_mode: settings.schedule_mode,
        schedule_times: settings.schedule_times,
        schedule_interval_minutes: settings.schedule_interval_minutes,
        schedule_timezone: settings.schedule_timezone,
        next_run_at: nextRunAt,
        server_time: Date.now() / 1000
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/results/:id', requireAuth, async (req, res, next) => {
    try {
      setNoStore(res);
      const run = runtime.store.getRun(req.params.id);
      if (!await canAccessRun(req, runtime, run)) {
        throw new AppError('RESULT_NOT_FOUND', '检测记录不存在', { status: 404 });
      }
      res.json({
        ...publicRun(run),
        html: run.output_type === 'html' ? run.output_text : null,
        text: run.output_type === 'text' ? run.output_text : null,
        artifact: run.preview_token && run.artifact_path ? {
          name: run.artifact_name,
          mime_type: run.artifact_mime,
          download_url: `/api/artifacts/${run.preview_token}?download=1`
        } : null,
        preview_url: run.preview_token ? `/api/previews/${run.preview_token}` : null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/groups/:groupId/runs', requireAuth, requireAdmin, requireCsrf, runLimiter, async (req, res, next) => {
    try {
      const group = await requireGroup(req, runtime);
      const monitor = requireConfiguredMonitor(group, runtime);
      res.status(202).json(runtime.scheduler.enqueue(monitor, 'manual'));
    } catch (error) {
      next(error);
    }
  });

  const nodeModules = path.join(config.projectRoot, 'node_modules');
  app.use('/vendor/lucide', express.static(path.join(nodeModules, 'lucide', 'dist', 'umd'), {
    immutable: true,
    maxAge: '7d'
  }));
  app.use(express.static(publicRoot, {
    etag: true,
    maxAge: config.env === 'production' ? '1h' : 0,
    index: false
  }));

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', '接口不存在', { status: 404 })));
  app.use((error, req, res, _next) => {
    const response = publicError(error);
    if (response.status >= 500) {
      console.error(JSON.stringify({
        event: 'request_failed',
        method: req.method,
        path: req.path,
        code: error.code || 'INTERNAL_ERROR',
        message: error.message
      }));
    }
    if (!res.headersSent) res.status(response.status).json(response.body);
  });

  if (overrides.startScheduler !== false) runtime.scheduler.start();
  return { app, runtime };
}

async function main() {
  const config = loadConfig();
  const { app, runtime } = createApp(config);
  const server = app.listen(config.port, config.bindHost, () => {
    console.log(JSON.stringify({
      event: 'server_started',
      host: config.bindHost,
      port: config.port,
      platforms: runtime.store.listPlatformConfigs(true).map((platform) => platform.platform)
    }));
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await runtime.scheduler.close();
    await runtime.sub2api.close?.();
    runtime.auth.close();
    runtime.store.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  PREVIEW_CSP,
  adminConfigurationPayload,
  artifactMime,
  availableGroups,
  createApp,
  createRuntime,
  demoGroups,
  discoverGroups,
  escapeHtml,
  groupPayload,
  platformGroups,
  requireGroup,
  safeArtifactPath,
  saveAdminConfiguration,
  seedDemo
};
