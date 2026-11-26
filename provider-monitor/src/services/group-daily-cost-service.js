const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { createAdapter } = require('../adapters/registry');
const { RequestBudget } = require('../http/request-budget');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = info => ({ id: info.id, name: info.name, complete: false, accountCovered: false, keys: [],
  reasons: ['分组消费暂不可用，请检查上游能力、凭据与目录同步状态'] });
const publicItem = item => Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_')));

class GroupDailyCostService {
  constructor({ db, config, providers, http, dailyCosts, now = () => new Date(), timeoutMs = 6000, reportTimeoutMs = 8500 }) {
    Object.assign(this, { db, config, providers, http, dailyCosts, now, timeoutMs, reportTimeoutMs });
    this.running = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS provider_group_daily_costs (
      provider_id TEXT NOT NULL,date TEXT NOT NULL,timezone TEXT NOT NULL,payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,PRIMARY KEY(provider_id,date,timezone))`);
  }

  allowed(date, timezone, archive) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(this.now());
    const value = type => parts.find(p => p.type === type).value;
    const today = `${value('year')}-${value('month')}-${value('day')}`;
    const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    return date === today || (archive && Number(value('hour')) >= 1 && date === yesterday);
  }

  configKey(connection) {
    return crypto.createHmac('sha256', this.config.secret).update(JSON.stringify([connection.base_url, connection.adapter_type,
      connection.auth_mode, connection.credential_id, connection.remote_user_id, connection.type_config_json,
      this.providers.getCredentials(connection)])).digest('hex');
  }

  catalog(providerId) {
    return this.db.prepare(`SELECT k.id,k.remote_id,k.name,k.masked_key,k.primary_group_ref,k.metadata_json,
      g.name AS group_name FROM remote_keys k LEFT JOIN remote_groups g ON g.connection_id=k.connection_id
      AND g.group_type='key_route_group' AND g.remote_id=k.primary_group_ref
      WHERE k.connection_id=? AND k.status<>'missing' ORDER BY k.id LIMIT 501`).all(providerId);
  }

  unavailable(info, query, archive) {
    const result = failure(info);
    // Today's directory can locate accounts even when the daily usage request times out.
    if (archive || !this.allowed(query.from, query.timezone, false)) return result;
    const catalog = this.catalog(info.id);
    if (!catalog.length || catalog.length > 500) return result;
    result.keys = catalog.map(key => {
      let metadata;
      try { metadata = JSON.parse(key.metadata_json); } catch { metadata = null; }
      return { id: key.id, name: key.name, maskedKey: key.masked_key,
        identity: /^[a-f0-9]{64}$/.test(metadata?.costKeyIdentity || '') ? metadata.costKeyIdentity : null,
        groupRef: key.primary_group_ref, groupName: key.group_name,
        upstreamAmount: null, cost: null, requests: null, complete: false,
        reasons: ['保留今日目录分组，日消费尚未核验'] };
    });
    result.reasons = ['上游日消费读取失败，保留今日 Key 目录关联；金额待核对'];
    return result;
  }

  async report(input = {}) {
    const { query, settings, periods } = this.dailyCosts.grossProfit.dailyCostOptions(input);
    if (query.from !== query.to || settings.currency !== 'CNY') throw new AppError('INVALID_REQUEST', 'One CNY finance day is required', { status: 400 });
    const archive = input.archive === '1', period = periods[0];
    const connections = this.db.prepare('SELECT id,name FROM provider_connections WHERE enabled=1 ORDER BY id LIMIT 501').all();
    if (connections.length > 500) throw new AppError('SOURCE_LIMIT', 'Too many enabled suppliers', { status: 503 });
    const budget = new RequestBudget(this.reportTimeoutMs), items = [];
    let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, connections.length) }, async () => {
        while (cursor < connections.length) {
          const connection = connections[cursor++];
          const row = this.db.prepare('SELECT * FROM provider_group_daily_costs WHERE provider_id=? AND date=? AND timezone=?')
            .get(connection.id, query.from, query.timezone);
          const cached = row && JSON.parse(row.payload), canFetch = this.allowed(query.from, query.timezone, archive);
          try {
            if (canFetch) budget.check();
            const configKey = canFetch ? this.configKey(this.providers.get(connection.id, { forAdapter: true })) : null;
            const archived = cached?._archived === true;
            const age = this.now().getTime() - Date.parse(row?.fetched_at);
            if (cached && (!canFetch || (cached._configKey === configKey && (archive || cached._settingsKey === digest(settings)) &&
                ((archive && archived && cached.complete) || (age >= 0 && age < 60000 && (!archive || archived)))))) {
              items.push({ ...cached, cached: true }); continue;
            }
            if (!canFetch) {
              items.push({ ...failure(connection), reasons: ['历史分组归档缺失，禁止重新拉取'] }); continue;
            }
            budget.check();
            const identity = JSON.stringify([connection.id, query.from, query.timezone, configKey, digest(settings), archive]);
            if (!this.running.has(identity)) {
              const task = this.read(connection, period, query, settings, archive, budget, cached)
                .finally(() => this.running.delete(identity));
              this.running.set(identity, task);
            }
            items.push(await budget.wait(this.running.get(identity)));
          } catch {
            items.push(cached ? { ...cached, stale: true, complete: false, reasons: ['本次分组消费读取失败，保留上次快照'] }
              : this.unavailable(connection, query, archive));
          }
        }
      }));
    } finally { budget.dispose(); }
    const counts = new Map();
    for (const item of items) if (item.accountKey) counts.set(item.accountKey, (counts.get(item.accountKey) || 0) + 1);
    return { source: 'upstream_key_group_daily_v1', date: query.from, timezone: query.timezone, currency: 'CNY',
      providerFilter: 'scheduled_enabled', items: items.map(item => counts.get(item.accountKey) > 1
        ? { ...publicItem(item), complete: false, accountCovered: false, reasons: ['同一个上游账号配置为多个供应商，请先消除重复关联'] }
        : publicItem(item)).sort((a, b) => a.id.localeCompare(b.id)), generatedAt: this.now().toISOString() };
  }

  async read(info, period, query, settings, archive, reportBudget, cached) {
    const budget = new RequestBudget(Math.min(this.timeoutMs, reportBudget.deadline - Date.now()), { signal: reportBudget.signal });
    try {
      const connection = this.providers.get(info.id, { forAdapter: true });
      const revision = value => digest([value.base_url, value.adapter_type, value.auth_mode, value.credential_id,
        value.remote_user_id, value.type_config_json]);
      const initialRevision = revision(connection), initialConfigKey = this.configKey(connection);
      // Archive retries reuse already observed values, even when upstream logs have expired.
      const previous = archive && cached?._archived ? cached : null;
      if (previous && previous._configKey !== initialConfigKey) throw new Error('archive configuration changed');
      let context;
      const verify = () => {
        budget.check();
        if (!this.allowed(query.from, query.timezone, archive)) throw new AppError('HISTORY_FETCH_FORBIDDEN', 'Finance day changed', { status: 409 });
        const latest = this.providers.get(info.id, { forAdapter: true });
        if (!latest.enabled || revision(latest) !== initialRevision) throw new AppError('CONFIG_CHANGED', 'Provider changed', { status: 409 });
        context?.verifyCredentials();
      };
      const http = { signal: budget.signal, requestJson: (url, options = {}) => {
        verify();
        return budget.run(() => this.http.requestJson(url, { ...options, retries: 0, signal: budget.signal,
          timeoutMs: Math.max(1, Math.min(10000, budget.deadline - Date.now())) }));
      } };
      context = this.providers.adapterContext(connection, http);
      const refresh = context.withCredentialsRefresh, saveCredentials = context.onCredentialsUpdated;
      context.withCredentialsRefresh = operation => refresh(() => budget.run(operation));
      context.onCredentialsUpdated = updated => { verify(); return saveCredentials(updated); };
      const adapter = createAdapter(connection.adapter_type, context);
      const catalog = previous?._catalog || this.catalog(info.id);
      if (catalog.length > 500 || !catalog.length) throw new Error('incomplete catalog');
      const snapshot = !archive && adapter.getDailyGroupUsageSnapshot
        ? await budget.run(() => adapter.getDailyGroupUsageSnapshot({ date: query.from, timezone: query.timezone,
          fromAt: period.from, toAt: period.to, previous: cached?._configKey === initialConfigKey ? cached._usageSnapshot : null })) : null;
      const account = snapshot?.account || previous?._account || await budget.run(() => adapter.getDailyUsageSummary({ date: query.from,
        timezone: query.timezone, fromAt: period.from, toAt: period.to }));
      if (account.scope !== 'account' || !account.subjectId || typeof account.amount !== 'number' || !Number.isFinite(account.amount) ||
          account.amount < 0 || !/^[A-Z][A-Z0-9_-]{0,11}$/.test(account.currency) ||
          !(account.requests === null || (Number.isSafeInteger(account.requests) && account.requests >= 0))) throw new Error('invalid summary');
      const keys = [];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, catalog.length) }, async () => {
        while (cursor < catalog.length) {
          const key = catalog[cursor++];
          let metadata;
          try { metadata = JSON.parse(key.metadata_json); } catch { metadata = {}; }
          if (!metadata || typeof metadata !== 'object') metadata = {};
          const base = { id: key.id, name: key.name, maskedKey: key.masked_key,
            identity: /^[a-f0-9]{64}$/.test(metadata.costKeyIdentity || '') ? metadata.costKeyIdentity : null };
          try {
            const saved = previous?.keys.filter(k => k.id === key.id);
            if (saved?.length && saved.every(k => k.upstreamAmount !== null)) {
              keys.push(...saved.map(k => {
                if (k.cost !== null) return k;
                const valuation = this.dailyCosts.valueCost(connection, { amount: k.upstreamAmount, currency: account.currency,
                  fetched_at: previous.computedAt }, period, settings);
                return { ...k, cost: valuation.cost, complete: valuation.cost !== null, reasons: valuation.reasons };
              }));
              continue;
            }
            if (!snapshot && !adapter.getKeyDailyGroupUsage) throw new Error('unsupported');
            const rows = snapshot ? [...(snapshot.keys.get(String(key.remote_id)) || [])]
              : await budget.run(() => adapter.getKeyDailyGroupUsage({ key, date: query.from,
                timezone: query.timezone, fromAt: period.from, toAt: period.to }));
            if (!rows.length) {
              const observed = cached?.keys.filter(k => k.id === key.id && k.identity === base.identity && k.upstreamAmount !== null);
              // Zero usage has no log group; historical membership requires an observation from that day.
              if (archive && (!observed?.length || new Set(observed.map(k => k.groupRef)).size !== 1)) throw new Error('historical zero group unknown');
              rows.push({ groupRef: archive ? observed[0].groupRef : key.primary_group_ref,
                groupName: archive ? observed[0].groupName : key.group_name, amount: 0, requests: 0, currency: account.currency });
            }
            if (rows.length > 1000 || new Set(rows.map(r => String(r.groupRef))).size !== rows.length) throw new Error('invalid groups');
            const entries = rows.map(row => {
              if (!row.groupRef || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0 ||
                  !Number.isSafeInteger(row.requests) || row.requests < 0 || row.currency !== account.currency) throw new Error('invalid');
              const valuation = this.dailyCosts.valueCost(connection, { amount: row.amount, currency: row.currency,
                fetched_at: this.now().toISOString() }, period, settings);
              return { ...base, groupRef: String(row.groupRef), groupName: String(row.groupName || key.group_name || row.groupRef).slice(0, 200),
                upstreamAmount: row.amount, cost: valuation.cost, requests: row.requests, complete: valuation.cost !== null,
                reasons: valuation.reasons };
            });
            keys.push(...entries);
          } catch { keys.push({ ...base, groupRef: archive ? null : key.primary_group_ref, groupName: archive ? null : key.group_name,
            upstreamAmount: null, cost: null, requests: null, complete: false, reasons: ['该 Key 的日分组消费无法完整核验'] }); }
        }
      }));
      verify();
      if (keys.length > 1000) throw new Error('group row limit exceeded');
      if (archive && cached && !cached._archived && keys.some(k => k.upstreamAmount !== null &&
          k.upstreamAmount < (cached.keys.find(old => old.id === k.id && old.groupRef === k.groupRef)?.upstreamAmount || 0))) {
        throw new Error('archived usage decreased below the last live observation');
      }
      const total = keys.reduce((sum, key) => sum + (key.upstreamAmount ?? 0), 0);
      const requests = keys.reduce((sum, key) => sum + (key.requests ?? 0), 0);
      const covered = keys.every(k => k.upstreamAmount !== null) && Math.abs(total - account.amount) <= Math.max(1e-7, Math.abs(account.amount) * 1e-10) &&
        (account.requests === null || account.requests === requests);
      const result = { id: info.id, name: info.name, complete: covered && keys.every(k => k.complete), accountCovered: covered,
        accountKey: crypto.createHmac('sha256', this.config.secret).update(JSON.stringify([connection.adapter_type,
          new URL(connection.base_url).origin, String(account.subjectId)])).digest('hex'),
        keys, reasons: covered ? [] : ['Key 消费合计未覆盖上游账号日汇总，不认定分组消费完整'],
        computedAt: this.now().toISOString(), _configKey: this.configKey(this.providers.get(info.id, { forAdapter: true })),
        _archived: archive, _catalog: catalog, _account: account, _usageSnapshot: snapshot?.state || null, _settingsKey: digest(settings) };
      this.db.prepare(`INSERT INTO provider_group_daily_costs VALUES(?,?,?,?,?) ON CONFLICT(provider_id,date,timezone)
        DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at`)
        .run(info.id, query.from, query.timezone, JSON.stringify(result), result.computedAt);
      return result;
    } finally { budget.dispose(); }
  }
}

module.exports = { GroupDailyCostService };
