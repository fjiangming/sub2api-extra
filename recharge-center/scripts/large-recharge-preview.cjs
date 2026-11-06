'use strict';

// Loopback-only example using a temporary ledger and simulated upstream services.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createRuntime } = require('../src/server');

async function startPreview({ port = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-bark-preview-'));
  const token = crypto.randomBytes(32).toString('hex');
  const controls = { barkMessages: [] };
  const runtime = createRuntime({
    NODE_ENV: 'test', RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',
    RECHARGE_CENTER_SECRET: crypto.randomBytes(48).toString('hex'), RECHARGE_CENTER_DATA_DIR: directory,
    SUB2API_BASE_URL: 'http://127.0.0.1:1'
  }, {
    sub2api: {
      async getCurrentUser(value) {
        if (![token, `${token}-user`].includes(value)) throw new Error('Invalid example session');
        return { id: value === token ? 1 : 2, email: value === token ? 'admin@example.test' : 'user@example.test',
          username: value === token ? '示例管理员' : '示例用户', role: value === token ? 'admin' : 'user', balance: 120 };
      },
      async createAndRedeem(_token, input) {
        return { redeem_code: { ...input, type: 'balance', status: 'used', used_by: input.userId } };
      }
    },
    notifications: { async send() {} },
    fetch: async () => { throw new Error('External network is disabled in this example'); },
    barkFetch: async (_url, options) => {
      controls.barkMessages.push(JSON.parse(options.body));
      return Response.json({ code: 200 });
    }
  });
  const admin = { user: { id: 1, role: 'admin' }, upstreamToken: token };
  for (const [index, amount] of ['500', '800', '1500'].entries()) {
    const user = { id: 10 + index, email: `sample${index}@example.test`, emailMasked: `sa***@example.test` };
    const order = runtime.orders.create(user, amount);
    const tradeNo = `20261106000000000000${String(index).padStart(6, '0')}`;
    runtime.orders.reportPayment(order.id, user, tradeNo);
    if (index !== 0) await runtime.orders.confirm(order.id, admin,
      { tradeNo, paidAmount: amount, paidAt: order.createdAt, acknowledge: true });
  }
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try {
      await runtime.auth.sso(req, res, req.query.role === 'user' ? `${token}-user` : token);
      res.redirect('/');
    } catch (error) { next(error); }
  });
  outer.use(runtime.app);
  const server = outer.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  runtime.config.publicOrigin = base;
  runtime.config.publicUrl = base;
  return { ...runtime, controls, base, port: server.address().port,
    async close() {
      await new Promise(resolve => server.close(resolve));
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

if (require.main === module) startPreview({ port: Number(process.env.RECHARGE_PREVIEW_PORT || 19894) }).then(preview => {
  console.log(`Isolated recharge example: ${preview.base}/preview`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { startPreview };
