'use strict';

const crypto = require('node:crypto');

const MATCH_VERSION = 6;
const FIELDS = ['InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheCreationTokens'];
const USAGE_FIELDS = [...FIELDS, 'CacheCreation5mTokens', 'CacheCreation1hTokens'];
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

function reconcileBillingRows(records, candidates, options, claims = []) {
  const tolerance = options.toleranceSeconds * 1000;
  const index = indexes(candidates), clocks = new Map();
  const accountOf = row => Object.hasOwn(options.accountMappings, row.key) ? String(options.accountMappings[row.key]) : '';
  const atOf = row => millis(row.time || row.startedAt) + (row.time ? Number(options.clockOffsetSeconds || 0) * 1000 : 0);
  const tokenPool = row => {
    const sig = signature(row.tokens);
    return sig ? index.tokens.get(`${scope(accountOf(row), row.model)}:${sig}`) || [] : [];
  };
  const agreesWithObservedUsage = (row, item) => {
    const evidence = item.usageEvidence;
    if (item.recorded || !evidence?.supported || evidence.invalid) return true;
    return USAGE_FIELDS.every(field => {
      const local = evidence.tokens[field], supplier = row.tokens?.[field];
      return local == null || supplier == null || (evidence.complete ? supplier === local : supplier >= local);
    });
  };
  const timedTokens = row => tokenPool(row).filter(item =>
    [item.nativeTiming ? item.endMs : NaN, item.startUncertain ? NaN : item.startMs]
      .some(at => Math.abs(atOf(row) - at) <= tolerance));
  const anchors = [], anchorCounts = new Map();
  // Repeated token tuples at different times remain useful. Each independent
  // native request may vote only once, never an unbilled request or duplicate.
  for (const row of records) {
    if (row.error || row.duplicateOf || !accountOf(row)) continue;
    const key = JSON.stringify([accountOf(row), row.key]);
    const votes = clocks.get(key) || { key: row.key, accountId: accountOf(row), start: 0, end: 0 };
    clocks.set(key, votes);
    const pool = timedTokens(row), item = pool.length === 1 ? pool[0] : null;
    if (!item?.nativeTiming || !Number.isFinite(atOf(row))) continue;
    const start = !item.startUncertain && Math.abs(atOf(row) - item.startMs) <= tolerance;
    const end = row.durationMs != null && Math.abs(atOf(row) - item.endMs) <= tolerance;
    if (start !== end) {
      anchors.push({ votes, reference: item.reference, kind: start ? 'start' : 'end' });
      anchorCounts.set(item.reference, (anchorCounts.get(item.reference) || 0) + 1);
    }
  }
  for (const anchor of anchors) if (anchorCounts.get(anchor.reference) === 1) anchor.votes[anchor.kind]++;
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
    const start = atOf(row) - (kind === 'end' && row.durationMs != null ? row.durationMs : 0);
    return { ...row, matchedTimeKind: kind || null, startedAt: new Date(start).toISOString(),
      matchedEndedAt: kind && row.durationMs != null ? new Date(start + row.durationMs).toISOString() : null };
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
      : pool.some(candidate => candidate.recorded) ? pool.every(candidate => candidate.recorded) ? 'recorded_conflict' : 'ambiguous'
        : pool.length > 1 ? owner && pool.length <= 30 ? 'owner_candidate' : 'ambiguous'
          : item.blockedReason ? item.kind === 'log' ? 'owner_candidate' : 'needs_review' : method === 'request_id' ? 'exact' : 'time_candidate';
    return { algorithmVersion: MATCH_VERSION, status, method, totalCandidates: pool.length,
      basis: method === 'tokens_time' ? '同上游账号、模型、四类 Token 与时间核对'
        : method === 'request_id' ? '同上游账号、模型与关联请求 ID 核对'
          : method === 'time' ? '同上游账号、模型与精确开始时间核对'
            : method === 'time_range' ? '仅有不确定的请求时间范围' : '',
      ...(owner ? { owner: { userId: owner.userId, apiKeyId: owner.apiKeyId, groupId: owner.groupId, accountId: owner.accountId } } : {}),
      ...(status === 'unmatched' ? { reason: '对应账号、模型和请求时段未找到可关联证据，请核查该时段日志是否留存并已接入' } : {}),
      ...(status === 'ambiguous' ? { reason: '存在多个用户、Key、分组或已有账单候选，需要核对具体请求证据' } : {}),
      ...(item?.blockedReason ? { reason: item.blockedReason } : {}),
      ...(status === 'owner_candidate' && pool.length > 1 ? { reason: '候选归属同一用户，但具体请求尚不唯一，不能自动补扣' } : {}),
      ...(status === 'billing_unresolved' ? { reason: '已有使用记录，未确认原生扣费成功；请核查原记录，不能按 CSV 再收整笔费用' } : {}),
      ...(status === 'recorded_conflict' ? { reason: '多个已有使用记录具有相同用量与相近时间，需要一对一核查，不能按新请求补扣' } : {}),
      ...(difference ? { reason: '已有记录与 CSV 用量不同，请在异常请求中核对累计用量与差额' } : {}),
      candidates: pool.slice(0, 30).map(candidate => ({ ...candidate, entry: undefined, tokens: undefined,
        rootIds: undefined, ids: undefined, correlationAvailable: Boolean(candidate.serverIds?.length || candidate.ids?.length),
        timeDifferenceMs: millis(row.startedAt) - candidate.startMs })),
      selected: item && !item.recorded && !item.blockedReason ? item.reference : null, ...extra };
  };
  const consumed = new Set();
  const matches = adjusted.map(row => {
    if (row.error) return finish(row, [], 'none', { status: 'invalid', reason: row.error });
    if (row.duplicateOf) return finish(row, [], 'none', { status: 'duplicate', reason: `与第 ${row.duplicateOf} 行重复` });
    const account = accountOf(row);
    if (!account) return finish(row, [], 'none', { status: 'unmapped', reason: '尚未指定该上游 Key 对应的账号' });
    const exact = row.requestId ? (index.ids.get(JSON.stringify([account, row.requestId])) || []).filter(item => sameModel(item, row)) : [];
    // Also check the other timestamp convention when excluding existing usage.
    // A wrong form setting must never turn a paid request into a new charge.
    const strong = timedTokens(row);
    if (strong.length) {
      for (const item of strong) consumed.add(item.reference);
      if (exact.length && !exact.some(item => strong.some(known => item.reference === known.reference))) return finish(row,
        [...new Set([...strong, ...exact])], 'conflicting_evidence', { status: 'recorded_conflict', selected: null,
          reason: '请求 ID 与 Token / 时间指向不同本地记录，请核查，不能按新账单补扣' });
      return finish(row, strong, 'tokens_time');
    }
    if (exact.length) {
      for (const item of exact.filter(item => item.recorded)) consumed.add(item.reference);
      if (exact.some(item => !agreesWithObservedUsage(row, item))) return finish(row, exact, 'request_id', {
        status: 'needs_review', selected: null, reason: '请求 ID 对应的已观察 Token 与 CSV 冲突，请核查最终用量' });
      return finish(row, exact, 'request_id');
    }
    return null;
  });
  const recorded = forcedAssignments(matches, match => match.method === 'tokens_time' &&
    match.candidates.every(item => item.recorded), true);
  for (const { index: n, reference, proof } of recorded.resolved) {
    const pool = timedTokens(adjusted[n]).filter(item => item.reference === reference);
    matches[n] = finish(adjusted[n], pool, 'tokens_time', { batchAssignment: proof });
  }
  for (const n of recorded.conflicts) Object.assign(matches[n], { status: 'recorded_conflict', selected: null,
    reason: '这些上游账单无法与已有记录完整一对一对应，请按整组核查，不能重复收费' });
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
    if (precise.length) {
      const compatible = precise.filter(item => agreesWithObservedUsage(row, item));
      const usageConstraints = { excluded: precise.length - compatible.length,
        references: precise.filter(item => !agreesWithObservedUsage(row, item)).slice(0, 30).map(item => item.reference) };
      matches[n] = compatible.length ? finish(row, compatible, 'time', { usageConstraints }) : finish(row, precise, 'time', {
        status: 'needs_review', selected: null, usageConstraints, reason: '时间候选的已观察 Token 均与 CSV 冲突，请核查最终用量' });
      continue;
    }
    const uncertain = index.times.get(`${key}:uncertain`) || [], pool = [];
    for (let i = lowerBound(uncertain, at - 4 * 3600000 - tolerance); i < uncertain.length && uncertain[i].startMs <= at + tolerance; i++) {
      const item = uncertain[i];
      if (!consumed.has(item.reference) && at <= item.endMs + tolerance) pool.push(item);
      if (pool.length > 30) break;
    }
    matches[n] = finish(row, pool, 'time_range', pool.length ? { status: 'time_uncertain', selected: null,
      reason: '本地缺少精确开始时间，仅有宽泛时间范围，不能据此确认遗漏归属' } : {});
  }
  const claimedBills = new Map(claims.map(claim => [JSON.stringify([String(claim.account_id), claim.bill_identity]), claim]));
  const claimedSources = new Map(claims.map(claim => [claim.local_reference, claim]));
  matches.forEach((match, i) => {
    const claim = claimedBills.get(JSON.stringify([accountOf(adjusted[i]), adjusted[i].identity]));
    if (claim && !adjusted[i].duplicateOf && !adjusted[i].error) {
      Object.assign(match, { status: claim.state === 'settled' ? 'already_imported' : 'import_pending', selected: null,
        importClaim: claim, reason: `该上游账单已被补记案件 ${claim.case_id} 认领${claim.state === 'settled' ? '并结算' : '，请续办原任务'}` });
    }
    for (const item of match.candidates) {
      const existing = [item.reference, ...(item.sourceEvidence || []).map(source => source.reference)].map(ref => claimedSources.get(ref)).find(Boolean);
      if (existing) { item.blockedReason = `该来源已被补记案件 ${existing.case_id} 认领`; item.importClaim = existing; }
    }
    if (!claim && match.candidates.some(item => item.importClaim) && !['already_recorded', 'duplicate', 'invalid'].includes(match.status)) {
      Object.assign(match, { status: 'needs_review', selected: null, reason: '候选来源已被其他上游账单认领，请核查原补记回执，不能重复收费' });
    }
  });
  const candidateGroups = resolveUniqueAssignments(matches, adjusted, candidates, options);
  const assignments = new Map();
  matches.forEach((match, i) => {
    const reference = match.selected || (match.candidates.length === 1 && match.candidates[0].recorded ? match.candidates[0].reference : null);
    if (reference) { const list = assignments.get(reference) || []; list.push(i); assignments.set(reference, list); }
  });
  for (const list of assignments.values()) if (list.length > 1) for (const i of list) Object.assign(matches[i], {
    status: matches[i].candidates[0]?.recorded ? 'recorded_conflict' : 'assignment_conflict', selected: null,
    reason: '多条上游记录对应同一本地请求，不能把一笔扣费视为多笔均已收费，也不能重复补扣' });
  const stages = { paid: 0, actionable: 0, review: 0, duplicate: 0, invalid: 0 };
  for (const match of matches) stages[['already_recorded', 'already_imported'].includes(match.status) ? 'paid'
    : ['exact', 'time_candidate', 'group_candidate'].includes(match.status) ? 'actionable'
      : ['duplicate', 'invalid'].includes(match.status) ? match.status : 'review']++;
  return { records: adjusted, matches, diagnostics: { algorithmVersion: MATCH_VERSION, clocks: [...clocks.values()], stages, candidateGroups,
    observedUsageExclusions: matches.reduce((count, match) => count + (match.usageConstraints?.excluded || 0), 0),
    sources: candidates.reduce((out, item) => { out[item.kind] = (out[item.kind] || 0) + 1; return out; }, {}) } };
}

// Resolve only edges required in every full one-to-one assignment. Choosing the
// nearest request would hide ambiguity during concurrent requests and retries.
function resolveUniqueAssignments(matches, records, allSources, options) {
  const eligible = new Set(['exact', 'time_candidate', 'owner_candidate', 'ambiguous']);
  const result = forcedAssignments(matches, match => eligible.has(match.status) &&
    match.candidates.every(item => !item.recorded && !item.blockedReason && !item.startUncertain), false);
  for (const { index, reference, proof } of result.resolved) {
    if (matches[index].totalCandidates === 1) continue;
    Object.assign(matches[index], { selected: reference, status: 'time_candidate', batchAssignment: proof,
      reason: '整批账单一对一核对后，该请求是唯一可行归属；请核对预览后确认' });
  }
  for (const index of result.conflicts) Object.assign(matches[index], { status: 'assignment_conflict', selected: null,
    reason: '多条上游账单争用本地请求，无法完整一对一分配，请核查重复账单或缺失的请求证据' });
  const totals = { groups: 0, sameOwner: 0, mixedOwners: 0, incomplete: 0, blocked: 0, auditable: 0, auditableRows: 0 };
  for (const group of result.groups) {
    if (group.forced === group.indices.length) continue;
    const sources = new Map(group.indices.flatMap(index => matches[index].candidates).map(item => [item.reference, item]));
    const owners = new Set([...sources.values()].map(item => JSON.stringify([item.accountId, ownerKey(item), item.billingType])));
    const sameOwner = owners.size === 1 && [...sources.values()].every(item => item.userId && item.apiKeyId && item.groupId);
    const status = group.blocked ? 'blocked' : !group.complete ? 'incomplete' : sameOwner ? 'sameOwner' : 'mixedOwners';
    const kinds = {};
    for (const item of sources.values()) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
    const unlinkedCases = Boolean(kinds.error && [...sources.values()].some(item => item.kind === 'case' &&
      !item.correlationAvailable));
    const analysis = { id: group.proof, status, rows: group.indices.length, sources: group.references.length,
      kinds, sameOwner, balanced: group.indices.length === group.references.length, allocationExists: group.complete,
      rowNumbers: group.indices.map(index => records[index].number).sort((a, b) => a - b).slice(0, 20), unlinkedCases,
      reason: group.blocked ? '候选组包含阻断证据或超过分析上限'
        : !group.complete ? '上游账单与本地来源无法完整一对一分配'
          : !sameOwner ? '同组存在不同用户、Key、分组或计费类型'
            : unlinkedCases ? '同组错误与案件可能重复描述请求，缺少共同关联 ID'
              : '用户归属一致，但逐笔对应仍有多解；整组费用与防重尚未核定' };
    const problem = groupAuditProblem(analysis, group.indices.map(index => records[index]), [...sources.values()], allSources, options);
    analysis.auditEligible = !problem;
    if (problem) analysis.auditReason = problem;
    else {
      // Sorting makes the bookkeeping allocation stable across reordered exports;
      // it is explicitly not presented as the historical request correspondence.
      const ordered = group.indices.slice().sort((a, b) => records[a].identity.localeCompare(records[b].identity));
      const assigned = new Map();
      const visit = (index, seen) => {
        for (const ref of matches[index].candidates.map(item => item.reference).sort()) {
          if (seen.has(ref)) continue;
          seen.add(ref);
          if (!assigned.has(ref) || visit(assigned.get(ref), seen)) { assigned.set(ref, index); return true; }
        }
        return false;
      };
      if (!ordered.every(index => visit(index, new Set()))) throw new Error('Invalid complete group allocation');
      analysis.allocations = [...assigned].map(([reference, index]) => ({ number: records[index].number,
        identity: records[index].identity, reference })).sort((a, b) => a.identity.localeCompare(b.identity));
      analysis.id = crypto.createHash('sha256').update(JSON.stringify(analysis.allocations.map(item => [item.identity, item.reference]))).digest('hex');
      analysis.reason = '整组归属及来源数量已核对，等待主站逐候选报价等价核查；逐笔历史对应仍不确定';
      for (const index of group.indices) Object.assign(matches[index], { status: 'group_candidate', selected: null, batchAssignment: null });
      totals.auditable++; totals.auditableRows += group.indices.length;
    }
    for (const index of group.indices) matches[index].candidateGroup = analysis;
    totals.groups++; totals[status]++;
  }
  return totals;
}

function groupAuditProblem(group, rows, sources, allSources, options) {
  if (group.status !== 'sameOwner' || !group.balanced || group.unlinkedCases) return group.reason;
  if (options.groupClaimsAvailable === false) return '主站整组认领与历史防重接口不可用，请先更新主站再重新分析';
  if (rows.length > 20) return '整组超过 20 笔，保留逐笔核查，不拆开认领';
  if (sources.some(item => !['log', 'error'].includes(item.kind) || item.billingType !== 'balance' || !item.correlationAvailable)) {
    return '整组自动补记仅接受具有独立关联 ID 的历史余额请求；持久案件或订阅继续逐笔核查';
  }
  if (rows.some(row => !row.identity || !signature(row.tokens) || row.tokens.CacheCreationTokens > 0 &&
    (row.tokens.CacheCreation5mTokens == null || row.tokens.CacheCreation1hTokens == null) ||
    row.billingMode && !/^(按量|tokens?|按token)$/i.test(row.billingMode))) return '整组缺少稳定账单身份或完整标准 Token / 缓存时长明细';
  const refs = new Set(sources.map(item => item.reference)), tolerance = options.toleranceSeconds * 1000;
  // A closed group cannot hide a plausible durable/paid/uncertain source just
  // because the earlier phase consumed it or preferred precise timestamps.
  for (const row of rows) for (const item of allSources) {
    if (refs.has(item.reference) || String(item.accountId) !== sources[0].accountId || !sameModel(item, row)) continue;
    const at = millis(row.startedAt), overlaps = item.startUncertain ? at >= item.startMs - tolerance && at <= item.endMs + tolerance
      : Math.abs(at - item.startMs) <= tolerance;
    if (!overlaps) continue;
    const sig = signature(item.tokens);
    if (item.recorded && sig && sig !== signature(row.tokens)) continue;
    return '同一请求时段还有组外已有用量、持久案件或不确定来源，无法核实完整覆盖';
  }
  return '';
}

function forcedAssignments(matches, eligible, recorded) {
  const rows = new Map(), refs = new Map(), blocked = new Set();
  const resolved = [], conflicts = [], groups = [];
  matches.forEach((match, index) => {
    if (!match) return;
    const usable = eligible(match) && match.totalCandidates <= 30 && match.candidates.length;
    if (!usable) { for (const item of match.candidates) if (Boolean(item.recorded) === recorded) blocked.add(item.reference); return; }
    rows.set(index, match.candidates.map(item => item.reference));
    for (const item of match.candidates) { const owners = refs.get(item.reference) || []; owners.push(index); refs.set(item.reference, owners); }
  });
  const seen = new Set();
  for (const first of rows.keys()) {
    if (seen.has(first)) continue;
    const component = [], queue = [first], sources = new Set();
    while (queue.length) {
      const index = queue.pop(); if (seen.has(index)) continue;
      seen.add(index); component.push(index);
      for (const ref of rows.get(index)) { sources.add(ref); for (const next of refs.get(ref)) if (!seen.has(next)) queue.push(next); }
    }
    const proof = crypto.createHash('sha256').update(JSON.stringify(component.slice().sort((a, b) => a - b).map(index => [index, rows.get(index)]))).digest('hex');
    const group = { indices: component, references: [...sources], proof, forced: 0, complete: false,
      blocked: component.length > 160 || sources.size > 400 || [...sources].some(ref => blocked.has(ref)) };
    groups.push(group);
    if (group.blocked) {
      conflicts.push(...component); continue;
    }
    const perfect = (withoutRow = -1, withoutRef = '') => {
      const assigned = new Map();
      const visit = (index, visited) => {
        for (const ref of rows.get(index)) {
          if (index === withoutRow && ref === withoutRef || visited.has(ref)) continue;
          visited.add(ref);
          if (!assigned.has(ref) || visit(assigned.get(ref), visited)) { assigned.set(ref, index); return true; }
        }
        return false;
      };
      return component.every(index => visit(index, new Set())) ? new Map([...assigned].map(([ref, index]) => [index, ref])) : null;
    };
    const assignment = perfect(); if (!assignment) { conflicts.push(...component); continue; }
    group.complete = true;
    for (const [index, reference] of assignment) {
      if (matches[index].totalCandidates > 1 && perfect(index, reference)) continue;
      resolved.push({ index, reference, proof });
      group.forced++;
    }
  }
  return { resolved, conflicts, groups };
}

const matchBillingRows = (records, candidates, options) => reconcileBillingRows(records, candidates, options).matches;
module.exports = { MATCH_VERSION, reconcileBillingRows, matchBillingRows };
