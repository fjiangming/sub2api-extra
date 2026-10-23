'use strict';

const MATCH_VERSION = 2;
const FIELDS = ['InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheCreationTokens'];
const clean = value => String(value || '').trim().toLowerCase();
const millis = value => value == null ? NaN : new Date(value).getTime();
const signature = tokens => FIELDS.every(key => tokens?.[key] != null && Number.isSafeInteger(Number(tokens[key])) && Number(tokens[key]) >= 0)
  ? FIELDS.map(key => Number(tokens[key])).join(':') : null;
const sameModel = (item, row) => item.models.some(model => clean(model) === clean(row.model));
const scope = (account, model) => JSON.stringify([String(account), clean(model)]);
const ownerKey = item => JSON.stringify([item.userId, item.apiKeyId, item.groupId]);

function indexes(candidates) {
  const ids = new Map(), tokens = new Map(), times = new Map();
  const add = (map, key, item) => { const list = map.get(key) || []; list.push(item); map.set(key, list); };
  for (const item of candidates) {
    for (const id of new Set(item.ids || [])) add(ids, JSON.stringify([item.accountId, id]), item);
    for (const model of new Set(item.models.map(clean))) {
      const key = scope(item.accountId, model), sig = signature(item.tokens);
      if (item.recorded && sig) add(tokens, `${key}:${sig}`, item);
      if (Number.isFinite(item.startMs)) add(times, `${key}:${item.startUncertain ? 'uncertain' : 'precise'}`, item);
    }
  }
  for (const list of times.values()) list.sort((a, b) => a.startMs - b.startMs);
  return { ids, tokens, times };
}

function lowerBound(list, at) {
  let low = 0, high = list.length;
  while (low < high) { const mid = (low + high) >>> 1; if (list[mid].startMs < at) low = mid + 1; else high = mid; }
  return low;
}

function reconcileBillingRows(records, candidates, options) {
  const tolerance = options.toleranceSeconds * 1000;
  const index = indexes(candidates), clocks = new Map();
  const accountOf = row => Object.hasOwn(options.accountMappings, row.key) ? String(options.accountMappings[row.key]) : '';
  const atOf = row => millis(row.time || row.startedAt) + (row.time ? Number(options.clockOffsetSeconds || 0) * 1000 : 0);
  const tokenPool = row => {
    const sig = signature(row.tokens);
    return sig ? index.tokens.get(`${scope(accountOf(row), row.model)}:${sig}`) || [] : [];
  };
  // Infer the timestamp convention only from unique complete native usage,
  // never from unbilled requests that we are trying to assign.
  for (const row of records) {
    if (row.error || row.duplicateOf || !accountOf(row)) continue;
    const key = JSON.stringify([accountOf(row), row.key]);
    const votes = clocks.get(key) || { key: row.key, accountId: accountOf(row), start: 0, end: 0 };
    clocks.set(key, votes);
    const pool = tokenPool(row), item = pool.length === 1 ? pool[0] : null;
    if (!item?.nativeTiming || !Number.isFinite(atOf(row))) continue;
    const start = !item.startUncertain && Math.abs(atOf(row) - item.startMs) <= tolerance;
    const end = row.durationMs != null && Math.abs(atOf(row) - item.endMs) <= tolerance;
    if (start && !end) votes.start++;
    if (end && !start) votes.end++;
  }
  for (const votes of clocks.values()) {
    const total = votes.start + votes.end;
    votes.detected = Math.max(votes.start, votes.end) >= 3 && Math.max(votes.start, votes.end) / total >= 0.9
      ? votes.start > votes.end ? 'start' : 'end' : null;
    votes.effective = options.timeKind === 'auto' ? votes.detected : options.timeKind;
    votes.conflict = Boolean(votes.detected && options.timeKind !== 'auto' && votes.detected !== options.timeKind);
  }
  const adjusted = records.map(row => {
    if (row.error || !row.time) return { ...row };
    const clock = clocks.get(JSON.stringify([accountOf(row), row.key]));
    const kind = clock?.effective;
    return { ...row, matchedTimeKind: kind || null,
      startedAt: new Date(atOf(row) - (kind === 'end' && row.durationMs != null ? row.durationMs : 0)).toISOString() };
  });
  const finish = (row, pool, method, extra = {}) => {
    const item = pool.length === 1 ? pool[0] : null;
    const difference = item?.recorded && item.tokens && Object.entries(row.tokens).some(([key, value]) =>
      value != null && item.tokens[key] != null && Number(item.tokens[key]) !== value);
    const owners = new Map();
    for (const candidate of pool) owners.set(ownerKey(candidate), candidate);
    const owner = owners.size === 1 && pool.every(candidate => candidate.userId && candidate.apiKeyId && candidate.groupId) ? owners.values().next().value : null;
    const corroborated = method === 'request_id' || signature(row.tokens) && signature(row.tokens) === signature(item?.tokens);
    const status = !pool.length ? 'unmatched' : item?.recorded ? difference ? 'usage_difference' : item.billed && corroborated ? 'already_recorded' : 'billing_unresolved'
      : pool.some(candidate => candidate.recorded) ? 'ambiguous'
        : pool.length > 1 ? owner && pool.length <= 30 ? 'owner_candidate' : 'ambiguous'
          : item.blockedReason ? item.kind === 'log' ? 'owner_candidate' : 'needs_review' : method === 'request_id' ? 'exact' : 'time_candidate';
    return { algorithmVersion: MATCH_VERSION, status, method, totalCandidates: pool.length,
      ...(owner ? { owner: { userId: owner.userId, apiKeyId: owner.apiKeyId, groupId: owner.groupId, accountId: owner.accountId } } : {}),
      ...(item?.blockedReason ? { reason: item.blockedReason } : {}),
      ...(status === 'owner_candidate' && pool.length > 1 ? { reason: '候选归属同一用户，但具体请求尚不唯一，不能自动补扣' } : {}),
      ...(status === 'billing_unresolved' ? { reason: '已有使用记录，未确认原生扣费成功；请核查原记录，不能按 CSV 再收整笔费用' } : {}),
      ...(difference ? { reason: '已有记录与 CSV 用量不同，请在异常请求中核对累计用量与差额' } : {}),
      candidates: pool.slice(0, 30).map(candidate => ({ ...candidate, entry: undefined, tokens: undefined,
        rootIds: undefined, ids: undefined, timeDifferenceMs: millis(row.startedAt) - candidate.startMs })),
      selected: item && !item.recorded && !item.blockedReason ? item.reference : null, ...extra };
  };
  const consumed = new Set();
  const matches = adjusted.map(row => {
    if (row.error) return finish(row, [], 'none', { status: 'invalid', reason: row.error });
    if (row.duplicateOf) return finish(row, [], 'none', { status: 'duplicate', reason: `与第 ${row.duplicateOf} 行重复` });
    const account = accountOf(row);
    if (!account) return finish(row, [], 'none', { status: 'unmapped', reason: '尚未指定该上游 Key 对应的账号' });
    const exact = row.requestId ? (index.ids.get(JSON.stringify([account, row.requestId])) || []).filter(item => sameModel(item, row)) : [];
    const known = tokenPool(row);
    // Also check the other timestamp convention when excluding existing usage.
    // A wrong form setting must never turn a paid request into a new charge.
    const strong = known.length === 1 && [known[0].nativeTiming ? known[0].endMs : NaN, known[0].startUncertain ? NaN : known[0].startMs]
      .some(at => Math.abs(atOf(row) - at) <= tolerance) ? known : [];
    if (strong.length) {
      consumed.add(strong[0].reference);
      if (exact.length && !exact.some(item => item.reference === strong[0].reference)) return finish(row,
        [...new Set([...strong, ...exact])], 'conflicting_evidence', { status: 'recorded_conflict', selected: null,
          reason: '请求 ID 与 Token / 时间指向不同本地记录，请核查，不能按新账单补扣' });
      return finish(row, strong, 'tokens_time');
    }
    if (exact.length) {
      for (const item of exact.filter(item => item.recorded)) consumed.add(item.reference);
      return finish(row, exact, 'request_id');
    }
    return null;
  });
  for (let n = 0; n < adjusted.length; n++) {
    if (matches[n]) continue;
    const row = adjusted[n], clock = clocks.get(JSON.stringify([accountOf(row), row.key]));
    if (clock?.conflict || options.timeKind === 'auto' && !clock?.effective || clock?.effective === 'end' && row.durationMs == null) {
      matches[n] = finish(row, [], 'none', { status: 'time_uncertain', reason: clock?.conflict
        ? `当前时间设置与原生用量证据冲突，检测为${clock.detected === 'end' ? '结束' : '开始'}时间，请改为自动或正确含义后重新匹配`
        : '缺少足够的时间校准证据，请核实 CSV 是开始还是结束时间并显式选择' });
      continue;
    }
    const at = millis(row.startedAt), key = scope(accountOf(row), row.model);
    const list = index.times.get(`${key}:precise`) || [], precise = [];
    for (let i = lowerBound(list, at - tolerance); i < list.length && list[i].startMs <= at + tolerance; i++) {
      if (!consumed.has(list[i].reference)) precise.push(list[i]);
    }
    if (precise.length) { matches[n] = finish(row, precise, 'time'); continue; }
    const uncertain = index.times.get(`${key}:uncertain`) || [], pool = [];
    for (let i = lowerBound(uncertain, at - 4 * 3600000 - tolerance); i < uncertain.length && uncertain[i].startMs <= at + tolerance; i++) {
      const item = uncertain[i];
      if (!consumed.has(item.reference) && at <= item.endMs + tolerance) pool.push(item);
      if (pool.length > 30) break;
    }
    matches[n] = finish(row, pool, 'time_range', pool.length ? { status: 'time_uncertain', selected: null,
      reason: '本地缺少精确开始时间，仅有宽泛时间范围，不能据此确认遗漏归属' } : {});
  }
  const assignments = new Map();
  matches.forEach((match, i) => {
    const reference = match.selected || (match.candidates.length === 1 && match.candidates[0].recorded ? match.candidates[0].reference : null);
    if (reference) { const list = assignments.get(reference) || []; list.push(i); assignments.set(reference, list); }
  });
  for (const list of assignments.values()) if (list.length > 1) for (const i of list) Object.assign(matches[i], {
    status: matches[i].candidates[0]?.recorded ? 'recorded_conflict' : 'assignment_conflict', selected: null,
    reason: '多条上游记录对应同一本地请求，不能把一笔扣费视为多笔均已收费，也不能重复补扣' });
  return { records: adjusted, matches, diagnostics: { algorithmVersion: MATCH_VERSION, clocks: [...clocks.values()],
    sources: candidates.reduce((out, item) => { out[item.kind] = (out[item.kind] || 0) + 1; return out; }, {}) } };
}

const matchBillingRows = (records, candidates, options) => reconcileBillingRows(records, candidates, options).matches;
module.exports = { MATCH_VERSION, reconcileBillingRows, matchBillingRows };
