'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../errors');

const MAX_GROUPS = 5000;
const MAX_MEMBERSHIPS = 50000;

class GroupMonitorSource {
  constructor({ pool, config }) { this.pool = pool; this.config = config; }

  scope() {
    return crypto.createHash('sha256').update(JSON.stringify([
      (this.pool && 'connectionString' in this.pool ? this.pool.connectionString : this.config.databaseUrl) || '',
      this.config.sub2apiBaseUrl || this.config.sub2apiPublicUrl || ''
    ])).digest('hex');
  }

  async read(task) {
    let client;
    try {
      if (!this.pool || this.pool.configured?.() === false) throw new Error('unconfigured');
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const result = await task(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError('GROUP_MONITOR_SOURCE_UNAVAILABLE', '无法读取主站分组、账号或 Key，请检查只读数据库连接和权限', { status: 503 });
    } finally { client?.release(); }
  }

  async snapshot() {
    return this.read(async client => {
      const groups = (await client.query(`SELECT g.id::text AS id,g.name,
        COALESCE(to_jsonb(g)->>'platform','anthropic') AS platform,
        g.rate_multiplier::text AS rate,g.status
        FROM public.groups g WHERE g.deleted_at IS NULL ORDER BY g.id LIMIT ${MAX_GROUPS + 1}`)).rows;
      const memberships = (await client.query(`SELECT ag.group_id::text AS group_id,a.id::text AS id,a.name,
        a.platform,a.status,to_jsonb(a)->>'rate_multiplier' AS rate,
        COALESCE((to_jsonb(a)->>'schedulable')::boolean,true) AS schedulable
        FROM public.account_groups ag JOIN public.accounts a ON a.id=ag.account_id
        JOIN public.groups g ON g.id=ag.group_id
        WHERE a.deleted_at IS NULL AND g.deleted_at IS NULL
        ORDER BY ag.group_id,a.id LIMIT ${MAX_MEMBERSHIPS + 1}`)).rows;
      if (groups.length > MAX_GROUPS || memberships.length > MAX_MEMBERSHIPS) {
        throw new AppError('GROUP_MONITOR_INVENTORY_LIMIT', '分组或账号关联超过巡检上限，本次未覆盖更新，请联系维护人员', { status: 503 });
      }
      const byGroup = new Map(groups.map(g => [g.id, { ...g, name: String(g.name).slice(0, 200), accounts: [] }]));
      for (const row of memberships) {
        byGroup.get(row.group_id)?.accounts.push({ id: row.id, name: String(row.name).slice(0, 200),
          platform: row.platform, rate: row.rate, status: row.status, schedulable: row.schedulable });
      }
      return [...byGroup.values()];
    });
  }

  async verifyKey(groupId, key) {
    return this.read(async client => {
      const row = (await client.query(`SELECT k.id::text AS id,k.group_id::text AS group_id,
        k.status,u.status AS user_status,to_jsonb(k)->>'expires_at' AS expires_at
        FROM public.api_keys k JOIN public.users u ON u.id=k.user_id
        WHERE k.key=$1 AND k.group_id=$2::bigint AND k.deleted_at IS NULL AND u.deleted_at IS NULL
        LIMIT 1`, [key, groupId])).rows[0];
      return Boolean(row && row.group_id === String(groupId) && row.status === 'active' && row.user_status === 'active'
        && (!row.expires_at || Date.parse(row.expires_at) > Date.now()));
    });
  }
}

module.exports = { GroupMonitorSource };
