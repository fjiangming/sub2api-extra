'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');

function installActivityRecharges(app, { config, db }, limiter) {
  app.get('/api/integrations/activity-center/recharges', limiter, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const expected = config.activityIntegrationToken;
      const header = String(req.get('authorization') || '');
      const actual = header.startsWith('Bearer ') ? header.slice(7) : '';
      const hash = value => crypto.createHash('sha256').update(value).digest();
      if (!expected || !crypto.timingSafeEqual(hash(expected), hash(actual))) throw new AppError('INTEGRATION_UNAUTHORIZED', '集成认证失败', { status: 401 });
      const { user_id: userId, since } = req.query;
      if (Object.keys(req.query).length !== 2 || typeof userId !== 'string' || !/^[1-9]\d{0,14}$/.test(userId) ||
          typeof since !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(since) || !Number.isFinite(Date.parse(since))) throw new AppError('INVALID_REQUEST', '请求参数无效', { status: 400 });
      const row = db.prepare(`SELECT COALESCE(SUM(payable_amount_minor),0) AS total
        FROM recharge_orders WHERE user_id = ? AND currency = 'CNY' AND status = 'completed'
        AND payment_mode IN ('personal_manual','personal_transfer_auto','personal_accountlog_static')
        AND verified_at IS NOT NULL AND trade_hash IS NOT NULL AND completed_at IS NOT NULL
        AND alipay_paid_at >= ? AND alipay_paid_at <= ?`).get(userId, since, new Date().toISOString());
      if (!Number.isSafeInteger(row.total) || row.total < 0) throw new AppError('RECHARGE_TOTAL_INVALID', '充值汇总无法核验', { status: 503 });
      res.json({ version: 1, userId, since, currency: 'CNY', totalMinor: String(row.total) });
    } catch (error) { next(error); }
  });
}

module.exports = { installActivityRecharges };
