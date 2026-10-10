'use strict';

const { createClient } = require('redis');
const { hash } = require('./security');
const { AppError,ensure } = require('./errors');

class CacheInvalidator {
  constructor(db, redis) { this.db = db; this.redis = redis; this.demoRpm = new Map(); }
  async ping() { if (this.redis) await this.redis.ping(); }
  async transaction(pipeline) {
    let timer;
    try {
      // The Redis client's MULTI/EXEC does not inherit its per-command timeout.
      return await Promise.race([pipeline.exec(),new Promise((_resolve,reject) => {
        timer = setTimeout(() => {
          if (this.redis.isOpen) this.redis.destroy();
          reject(new AppError('CACHE_UNAVAILABLE','Native cache transaction timed out',503));
        },5000);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }
  async enforceRpm(who) {
    const groupLimit = who.rpm_override ?? who.grp.rpm_limit;
    const userLimit = who.usr.rpm_limit;
    if (!(groupLimit>0 || userLimit>0)) return;
    let minute;
    try {
      const seconds = this.redis ? (await this.redis.sendCommand(['TIME']))[0] : Math.floor(Date.now()/1000);
      minute = Math.floor(Number(seconds)/60);
      ensure(Number.isSafeInteger(minute),'CACHE_TIME_INVALID','Native rate cache returned invalid time',503);
    } catch { throw new AppError('CACHE_UNAVAILABLE','Native rate cache is unavailable',503); }
    const limits = [
      { key:`rpm:ug:${who.usr.id}:${who.grp.id}:${minute}`,limit:groupLimit,code:'GROUP_RPM_LIMIT' },
      { key:`rpm:u:${who.usr.id}:${minute}`,limit:userLimit,code:'USER_RPM_LIMIT' }
    ];
    for (const item of limits.filter(item => item.limit>0)) {
      let count;
      try {
        if (this.redis) {
          const replies = await this.transaction(this.redis.multi().incr(item.key).expire(item.key,120));
          if (replies.some(reply => reply instanceof Error)) throw new Error('Native RPM update failed');
          count = Number(replies[0]);
        } else {
          for (const [key,value] of this.demoRpm) if (value.minute<minute) this.demoRpm.delete(key);
          count = (this.demoRpm.get(item.key)?.count || 0)+1;
          this.demoRpm.set(item.key,{ minute,count });
        }
        ensure(Number.isSafeInteger(count) && count>0,'CACHE_COUNT_INVALID','Native rate cache returned invalid count',503);
      } catch { throw new AppError('CACHE_UNAVAILABLE','Native rate cache could not record this request',503); }
      ensure(count<=item.limit,item.code,'Native request rate limit reached',429);
    }
  }
  async flush() {
    if (!this.redis) { await this.db.query('DELETE FROM video_adapter.cache_outbox'); return true; }
    const pending = await this.db.query('SELECT * FROM video_adapter.cache_outbox ORDER BY id LIMIT 100');
    for (const item of pending.rows) {
      const { rows } = await this.db.query('SELECT id,key FROM api_keys WHERE user_id=$1', [item.user_id]);
      const pipeline = this.redis.multi();
      pipeline.del(`billing:balance:${item.user_id}`);
      for (const key of rows) {
        const fingerprint = hash(key.key);
        pipeline.del(`apikey:auth:${fingerprint}`);
        pipeline.del(`apikey:rate:${key.id}`);
        pipeline.publish('auth:cache:invalidate', fingerprint);
      }
      const replies = await this.transaction(pipeline);
      if (replies.some(reply => reply instanceof Error)) throw new AppError('CACHE_INVALIDATION_FAILED','Native cache invalidation failed',503);
      await this.db.query('DELETE FROM video_adapter.cache_outbox WHERE id=$1', [item.id]);
    }
    const { rows } = await this.db.query('SELECT count(*)::int AS count FROM video_adapter.cache_outbox');
    return rows[0].count===0;
  }
  async close() { if (this.redis?.isOpen) this.redis.destroy(); }
}

async function createCache(db, config) {
  if (!config.production) return new CacheInvalidator(db, null);
  const redis = createClient({ url: config.redisUrl,disableOfflineQueue:true,commandOptions:{ timeout:5000 },
    socket: { connectTimeout: 5000, reconnectStrategy: retries => retries>5 ? new Error('Redis connection unavailable') : Math.min(retries * 200, 1000) } });
  redis.on('error', () => console.error(JSON.stringify({ event: 'redis_connection_error' })));
  try { await redis.connect(); }
  catch { redis.destroy(); throw new AppError('CACHE_UNAVAILABLE','Redis connection could not be established',503); }
  return new CacheInvalidator(db, redis);
}

module.exports = { CacheInvalidator, createCache };
