'use strict';

const crypto = require('node:crypto');

const TICK_MS = 5 * 60000;
const DAY_MS = 86400000;
const dayStarts = new Map();
const formatters = new Map();
const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayDifference = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const digest = (seed) => crypto.createHash('sha256').update(seed).digest('hex');
function randomSource(seed) {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function localDate(time, timezone) {
  if (!formatters.has(timezone)) {
    if (formatters.size >= 16) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }));
  }
  return formatters.get(timezone).format(new Date(time));
}
function dayStart(date, timezone) {
  const key = `${timezone}:${date}`;
  if (dayStarts.has(key)) return dayStarts.get(key);
  const nominal = Date.parse(`${date}T00:00:00Z`);
  let low = nominal - 36 * 3600000;
  let high = nominal + 36 * 3600000;
  // Search calendar boundaries in UTC so repeated/skipped local hours cannot reverse progress.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle, timezone) < date) low = middle;
    else high = middle;
  }
  if (dayStarts.size >= 64) dayStarts.delete(dayStarts.keys().next().value);
  dayStarts.set(key, high);
  return high;
}
function progress(seed, key, date, time, start, end) {
  const random = randomSource(`${seed}:activity:${key}:${date}`);
  const phase = random();
  const slots = Math.ceil((end - start) / TICK_MS);
  const completed = Math.min(slots, Math.max(0, Math.floor((time - start) / TICK_MS)));
  let total = 0;
  let consumed = 0;
  for (let slot = 0; slot < slots; slot++) {
    const active = random();
    const distance = Math.abs(slot / slots - phase);
    const weight = active < .4 ? 0 : (.15 + random()) * (distance < .2 ? 4 : 1);
    total += weight;
    if (slot < completed) consumed += weight;
  }
  return total ? consumed / total : completed / Math.max(1, slots);
}

function evolveTimeline(baseline, history, now) {
  const originTime = Date.parse(baseline.generatedAt);
  const time = Math.max(originTime, Math.floor(now.getTime() / TICK_MS) * TICK_MS);
  const date = localDate(time, baseline.timezone);
  const elapsed = Math.max(0, dayDifference(baseline.date, date));
  const minimum = Math.max(baseline.rules.minimumTokens, baseline.rules.boardMinimumTokens);
  const maximum = Math.min(baseline.rules.maximumTokens, baseline.rules.boardMaximumTokens);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const starts = { today: date, week: shiftDay(date, -((weekday + 6) % 7)), month: `${date.slice(0, 7)}-01` };
  const beginning = dayStart(date, baseline.timezone);
  const end = dayStart(shiftDay(date, 1), baseline.timezone);
  const reservedNames = new Set(baseline.rows.map((row) => row.name));
  // Disjoint name pools keep a surviving identity's name stable as other slots renew.
  const prefixes = Array.from({ length: 676 }, (_, i) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`)
    .filter((prefix) => !reservedNames.has(`${prefix}***@example.com`));
  const nameCycles = Math.floor(prefixes.length / 10);
  const rows = baseline.rows.map((row, index) => {
    const random = randomSource(`${baseline.seed}:pace:${row.key}`);
    const dailyTokens = Math.max(minimum + 1, Math.round(row.values.today.tokens * (.9 + random() * .2)));
    const firstGrowth = Math.min(maximum - row.values.all.tokens, Math.max(1, Math.round(dailyTokens * (.04 + random() * .08))));
    const headroom = maximum - row.values.all.tokens - firstGrowth;
    // The last day may use the remaining quota; the next day starts a distinct example identity.
    const followingDays = headroom < minimum ? 0 : 1 + Math.floor((headroom - minimum) / dailyTokens);
    const lifetime = 1 + followingDays;
    const cycle = Math.floor(elapsed / lifetime);
    const offset = elapsed % lifetime;
    const shift = cycle * lifetime;
    const startDate = shiftDay(baseline.date, shift);
    const key = cycle ? `sim_${digest(`${baseline.seed}:renewal:${row.key}:${cycle}`).slice(0, 16)}` : row.key;
    const name = cycle ? `${prefixes[index + 10 * ((cycle - 1) % nameCycles)]}***@example.com` : row.name;
    const ratio = row.values.today.requests / row.values.today.tokens;
    const requests = (tokens) => tokens ? Math.max(1, Math.round(tokens * ratio)) : 0;
    const growthRequests = requests(firstGrowth);
    const dailyRequests = requests(dailyTokens);
    const available = maximum - row.values.all.tokens - firstGrowth - Math.max(0, offset - 1) * dailyTokens;
    const target = Math.min(dailyTokens, available);
    const fraction = progress(baseline.seed, key, date, time, beginning, end);
    let current;
    if (offset === 0) {
      const initial = cycle ? 0 : progress(baseline.seed, key, date, originTime, beginning, end);
      const portion = initial < 1 ? Math.max(0, (fraction - initial) / (1 - initial)) :
        Math.min(1, Math.max(0, (time - originTime) / Math.max(1, end - TICK_MS - originTime)));
      current = { tokens: Math.floor(firstGrowth * portion), requests: Math.floor(growthRequests * portion) };
    } else {
      const floorRequests = requests(minimum);
      current = { tokens: minimum + Math.floor((target - minimum) * fraction),
        requests: floorRequests + Math.floor((requests(target) - floorRequests) * fraction) };
    }
    const values = Object.fromEntries(['today', 'week', 'month', 'all'].map((period) => [period, { tokens: 0, requests: 0 }]));
    for (const period of Object.keys(values)) {
      const value = values[period];
      const from = starts[period];
      for (const day of history.get(row.key)) {
        if (period !== 'all' && shiftDay(day.date, shift) < from) continue;
        value.tokens += day.tokens;
        value.requests += day.requests;
      }
      if (offset && (period === 'all' || startDate >= from)) {
        value.tokens += firstGrowth;
        value.requests += growthRequests;
      }
      const completed = offset ? Math.max(0, offset - Math.max(1, period === 'all' ? 1 : dayDifference(startDate, from))) : 0;
      value.tokens += completed * dailyTokens + current.tokens;
      value.requests += completed * dailyRequests + current.requests;
    }
    return { key, name, avatar: row.avatar, values };
  });
  return { rows, date, generatedAt: new Date(time).toISOString() };
}

module.exports = { evolveTimeline, TICK_MS };
