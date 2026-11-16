'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRuntime } = require('../src/server');
const { AppError } = require('../src/errors');

async function startPreview({ port = 19927, seed = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-activity-preview-'));
  const credited = new Map(); const values = new Map([['42',600000],['99',100000],['1',500000]]);
  let receiptId = 0; let creditFailure = false;
  const core = {
    async me(token) {
      if (!['preview-user','preview-admin','preview-other'].includes(token)) throw new AppError('AUTH_REQUIRED','演示登录已过期',401);
      return { id: token === 'preview-admin' ? '1' : token === 'preview-other' ? '99' : '42',
        email: token === 'preview-admin' ? 'admin@example.test' : 'preview@example.test',
        name: token === 'preview-admin' ? '演示管理员' : '示例用户',role: token === 'preview-admin' ? 'admin' : 'user' };
    },
    async credit(row) {
      if (creditFailure) throw new AppError('UPSTREAM_UNAVAILABLE','模拟连接中断',503);
      if (!credited.has(row.credit_code)) credited.set(row.credit_code,{ id: ++receiptId,code: row.credit_code,type: 'balance',status: 'used',value: row.amount_minor/100,
        used_by: Number(row.user_id),used_at: new Date().toISOString(),notes: `活动奖励; activity=recharge-lottery; reward=${row.id}; batch=${row.batch_id}` });
      return { redeem_code: { ...credited.get(row.credit_code) } };
    }
  };
  const source = { values, async total(id) { return values.get(id) || 0; } };
  let roll = 0; const rolls = [0,5100,7500,8500,9300,9600,9850,9999];
  const runtime = createRuntime({ NODE_ENV: 'test',ACTIVITY_CENTER_PORT: String(port || 19927),
    ACTIVITY_CENTER_DATA_DIR: directory,SUB2API_DATABASE_URL: 'postgres://synthetic:synthetic@localhost/preview',SUB2API_ADMIN_API_KEY: 'synthetic-preview-admin-key'
  }, { core,source,worker: false,storeOptions: { rng: () => rolls[roll++ % rolls.length] } });
  if (seed) {
    const user = await core.me('preview-user');
    runtime.store.reserve(user,crypto.randomUUID(),10,600000);
    await runtime.lottery.kick();
    const pending = runtime.store.reserve({ ...user,id: '99',name: '另一位用户',email: 'other@example.test' },crypto.randomUUID(),1,100000);
    runtime.store.db.prepare("UPDATE rewards SET next_attempt_at=? WHERE id=?").run(Date.now()+86400000,pending.rewards[0].id);
    const failed = runtime.store.reserve(user,crypto.randomUUID(),1,600000);
    runtime.store.db.prepare("UPDATE rewards SET status='failed',error_code='CREDIT_RECEIPT_UNVERIFIED',attempts=1 WHERE id=?").run(failed.rewards[0].id);
  }
  const server = runtime.app.listen(port,'127.0.0.1');
  await new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  runtime.config.publicUrl = base;
  runtime.lottery.start();
  return { ...runtime,base,directory,credited,server,source,
    setCreditFailure(value) { creditFailure = value; },
    async close() { await new Promise(resolve => server.close(resolve)); await runtime.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
  };
}

if (require.main === module) startPreview({ port: Number(process.env.ACTIVITY_PREVIEW_PORT || 19927) }).then(preview => {
  console.log(`User: ${preview.base}/?token=preview-user`);
  console.log(`Admin: ${preview.base}/?token=preview-admin`);
  const close = () => preview.close().then(() => process.exit(0));
  process.on('SIGINT',close); process.on('SIGTERM',close);
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { startPreview };
