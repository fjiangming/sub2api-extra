const { AppError } = require('../errors');

const BARK_LEVELS = new Set(['active', 'timeSensitive', 'critical', 'passive']);
const MAX_BARK_PERIODS = 24;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function invalidSchedule(message) {
  throw new AppError('NOTIFICATION_CONFIG_INVALID', message, { status: 400 });
}

function validateBarkLevelSchedule(schedule) {
  if (schedule == null) return;
  if (typeof schedule !== 'object' || Array.isArray(schedule) || typeof schedule.enabled !== 'boolean') {
    invalidSchedule('分时段提醒配置无效，请使用开关启用或关闭');
  }
  if (!schedule.enabled) return;
  if (typeof schedule.timezone !== 'string' || !schedule.timezone || schedule.timezone.length > 80) {
    invalidSchedule('请选择有效的提醒时区');
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone });
  } catch {
    invalidSchedule('提醒时区无效，请填写 Asia/Shanghai 等有效时区');
  }
  if (!Array.isArray(schedule.periods) || schedule.periods.length < 1 || schedule.periods.length > MAX_BARK_PERIODS) {
    invalidSchedule(`分时段提醒需要配置 1 至 ${MAX_BARK_PERIODS} 个时段`);
  }

  const segments = [];
  for (const [index, period] of schedule.periods.entries()) {
    if (!period || typeof period !== 'object' ||
        typeof period.start !== 'string' || !CLOCK_TIME.test(period.start) ||
        typeof period.end !== 'string' || !CLOCK_TIME.test(period.end)) {
      invalidSchedule(`第 ${index + 1} 个提醒时段需要有效的开始和结束时间（00:00 至 23:59）`);
    }
    if (!BARK_LEVELS.has(period.level)) {
      invalidSchedule(`第 ${index + 1} 个提醒时段的提醒级别无效`);
    }
    const start = minutes(period.start);
    const end = minutes(period.end);
    if (start === end) invalidSchedule(`第 ${index + 1} 个提醒时段的开始和结束时间不能相同`);
    // Split overnight periods so overlap checks include both sides of midnight.
    if (start < end) segments.push([start, end]);
    else segments.push([start, 1440], [0, end]);
  }
  const ordered = segments.filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index][0] < ordered[index - 1][1]) {
      invalidSchedule('提醒时段不能重叠，请调整开始或结束时间');
    }
  }
}

function resolveBarkLevel(config, now = new Date()) {
  const fallback = config.level || 'active';
  const schedule = config.levelSchedule;
  if (schedule?.enabled !== true) return fallback;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: schedule.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const current = Number(values.hour) * 60 + Number(values.minute);
  const period = schedule.periods.find((entry) => {
    const start = minutes(entry.start);
    const end = minutes(entry.end);
    return start < end ? current >= start && current < end : current >= start || current < end;
  });
  return period?.level || fallback;
}

module.exports = { BARK_LEVELS, validateBarkLevelSchedule, resolveBarkLevel };
