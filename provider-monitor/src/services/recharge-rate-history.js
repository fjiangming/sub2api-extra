const { AppError } = require('../errors');
const { startOfDateInTimezone } = require('./gross-profit-service');

function dateKey(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function historyOptions(config, now = new Date()) {
  const timezone = config.timezone || 'Asia/Shanghai';
  return { timezone, today: dateKey(now, timezone) };
}

function initialHistory(db, connectionId, config) {
  const first = db.prepare(`SELECT valid_from,multiplier,source FROM provider_recharge_rate_history
    WHERE connection_id=? AND source<>'default' ORDER BY valid_from,id LIMIT 1`).get(connectionId);
  return { ...historyOptions(config), firstConfirmedAt: first?.valid_from || null,
    firstMultiplier: first?.multiplier || null };
}

function confirmInitialRate(db, connectionId, input, config, observedAt) {
  const { timezone, today } = historyOptions(config, new Date(observedAt));
  const date = input?.effectiveDate;
  const valid = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  const multiplier = input?.multiplier;
  if (!valid || date < '1970-01-01' || date > today || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000000) {
    throw new AppError('RECHARGE_HISTORY_INVALID', '请填写有效的初始倍率和不晚于今天的生效日期', { status: 400 });
  }
  const from = startOfDateInTimezone(date, timezone).toISOString();
  const rows = db.prepare(`SELECT * FROM provider_recharge_rate_history
    WHERE connection_id=? ORDER BY valid_from,id`).all(connectionId);
  const first = rows.find(row => row.source !== 'default' && row.multiplier > 0);
  if (!first) throw new AppError('RECHARGE_HISTORY_UNCONFIRMED', '请先填写当前充值倍率或完成自动检测，再补齐初始倍率', { status: 409 });
  if (Date.parse(from) > Date.parse(first.valid_from)) {
    throw new AppError('RECHARGE_HISTORY_CONFLICT', '生效日期必须早于首次确认时间，不会覆盖已有倍率历史', { status: 409 });
  }
  if (Date.parse(from) === Date.parse(first.valid_from)) {
    if (multiplier === first.multiplier) return { changed: false, from, to: first.valid_from };
    throw new AppError('RECHARGE_HISTORY_CONFLICT', '该时段已有已确认倍率，不能通过补齐操作覆盖', { status: 409 });
  }
  const replaced = rows.filter(row => row.source === 'default' && Date.parse(row.valid_from) < Date.parse(first.valid_from) &&
    (!row.valid_to || Date.parse(row.valid_to) > Date.parse(from)));
  // Only replace the unconfirmed prefix; later confirmed rates retain their original boundaries.
  for (const row of replaced) {
    if (Date.parse(row.valid_from) < Date.parse(from)) db.prepare('UPDATE provider_recharge_rate_history SET valid_to=? WHERE id=?').run(from, row.id);
    else db.prepare('DELETE FROM provider_recharge_rate_history WHERE id=?').run(row.id);
  }
  const details = { effectiveDate: date, timezone, multiplier, from, to: first.valid_from,
    replacedDefaults: replaced };
  db.prepare(`INSERT INTO provider_recharge_rate_history(connection_id,multiplier,source,status,
    paid_currency,balance_currency,valid_from,valid_to,observed_at,context_json)
    VALUES (?,?,'manual_initial','manual',?,?,?,?,?,?)`).run(connectionId, multiplier,
    first.paid_currency, first.balance_currency, from, first.valid_from, observedAt, JSON.stringify(details));
  db.prepare(`INSERT INTO audit_logs(action,target_type,target_id,details_json,created_at)
    VALUES ('provider.recharge_history.confirm','provider',?,?,?)`).run(connectionId, JSON.stringify(details), observedAt);
  return { changed: true, from, to: first.valid_from };
}

module.exports = { historyOptions, initialHistory, confirmInitialRate };
