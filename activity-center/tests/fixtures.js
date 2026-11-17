'use strict';

const { loadConfig } = require('../src/config');
const { Store } = require('../src/store');
const { Lottery } = require('../src/lottery');

const USER = Object.freeze({ id: '42', name: '示例用户', email: 'user@example.test', role: 'user' });
function config(extra = {}) {
  return { ...loadConfig({ NODE_ENV: 'test', SUB2API_DATABASE_URL: 'postgres://synthetic:synthetic@localhost/test',
    SUB2API_ADMIN_API_KEY: 'synthetic-admin-key-0123456789' }), ...extra };
}
function fixture(t, options = {}) {
  let now = Date.parse('2026-11-16T08:00:00Z');
  const cfg = config(options.config);
  const store = new Store(cfg, { filename: ':memory:', now: () => now, rng: () => 0, ...options.storeOptions });
  const credited = new Map();
  const attempts = [];
  const core = {
    async me() { return { ...USER }; },
    async credit(row) {
      attempts.push({ ...row });
      if (!credited.has(row.credit_code)) credited.set(row.credit_code, { id: credited.size+1, code: row.credit_code, type: row.credit_type, value: row.amount_minor/100,
        status: 'used', used_by: Number(row.user_id), used_at: new Date(now).toISOString(),
        notes: `活动奖励; activity=recharge-lottery; reward=${row.id}; batch=${row.batch_id}` });
      return { redeem_code: { ...credited.get(row.credit_code) } };
    }
  };
  const source = { value: 500000, calls: 0, async total() { this.calls++; if (this.error) throw this.error; return this.value; } };
  const lottery = new Lottery(store, source, core);
  t.after(async () => { await lottery.close(); store.close(); });
  return { config: cfg, store, core, source, lottery, credited, attempts, now: () => now, advance: value => { now += value; } };
}

module.exports = { config, fixture, USER };
