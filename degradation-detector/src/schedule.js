'use strict';

const formatterCache = new Map();

function parseDailyTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error('每日检测时间必须使用 HH:mm 格式');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('每日检测时间无效');
  return { hour, minute, value: `${match[1]}:${match[2]}` };
}

function formatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(timestamp, timeZone) {
  const values = {};
  for (const part of formatter(timeZone).formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function zonedDateTimeToUtc(parts, timeZone) {
  const expected = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  let guess = expected;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = zonedParts(guess, timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = expected - represented;
    if (correction === 0) return guess;
    guess += correction;
  }
  return guess;
}

function nextDailyRunAt(dailyTime, from = Date.now(), timeZone = 'Asia/Shanghai') {
  const { hour, minute } = parseDailyTime(dailyTime);
  const fromMs = Number(from);
  if (!Number.isFinite(fromMs)) throw new Error('调度基准时间无效');
  const local = zonedParts(fromMs, timeZone);
  let candidate = zonedDateTimeToUtc({
    year: local.year,
    month: local.month,
    day: local.day,
    hour,
    minute,
    second: 0
  }, timeZone);
  if (candidate <= fromMs) {
    const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    candidate = zonedDateTimeToUtc({
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
      hour,
      minute,
      second: 0
    }, timeZone);
  }
  return candidate;
}

module.exports = { nextDailyRunAt, parseDailyTime, zonedDateTimeToUtc, zonedParts };
