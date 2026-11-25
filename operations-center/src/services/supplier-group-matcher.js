'use strict';
const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const total = (items, field) => items.reduce((sum, item) => sum.plus(item[field] ?? 0), new Decimal(0)).toDecimalPlaces(8).toNumber();
const unique = values => [...new Set(values)];
const groupId = (provider, group) => crypto.createHash('sha256').update(JSON.stringify([provider, group])).digest('hex').slice(0, 32);
function aliases(provider, settings) {
  const stem = norm(String(provider.name).replace(/\s*api\s*$/i, ''));
  const configured = Object.hasOwn(settings.aliases, provider.id) ? settings.aliases[provider.id] : [];
  return unique([...configured, stem].map(norm).filter(v =>
    v.length >= 2 && !['api', 'https', 'http', 'com', 'cn', 'vip', 'relay', 'cloud', 'provider', '供应商'].includes(v)));
}
function buildGroupReport(upstream, source, settings, date, at) {
  const names = upstream.items.map(provider => ({ provider, full: norm(provider.name), aliases: aliases(provider, settings) }));
  const groups = new Map(), keyTargets = new Map();
  for (const provider of upstream.items) for (const key of provider.keys) {
    const id = groupId(provider.id, key.groupRef || 'unassigned');
    if (!groups.has(id)) groups.set(id, { id, providerId: provider.id, providerName: provider.name,
      groupRef: key.groupRef, name: key.groupName || key.groupRef || '上游分组未定位', keys: [], reasons: [...(provider.reasons || [])] });
    const item = { id: key.id, name: key.name, maskedKey: key.maskedKey, upstream: key.cost,
      upstreamComplete: key.complete === true && provider.accountCovered === true && !provider.stale,
      accounts: [], blocked: false, reasons: key.reasons || [] };
    groups.get(id).keys.push(item);
    if (key.identity) {
      if (!keyTargets.has(key.identity)) keyTargets.set(key.identity, []);
      keyTargets.get(key.identity).push({ provider, group: groups.get(id), key: item });
    }
  }
  const mappings = [];
  const usageByAccount = new Map();
  for (const row of source.usage) {
    if (!usageByAccount.has(row.account_id)) usageByAccount.set(row.account_id, []);
    usageByAccount.get(row.account_id).push(row);
  }
  const inventory = [...source.accounts], accountIds = new Set(inventory.map(a => a.id));
  for (const id of usageByAccount.keys()) if (!accountIds.has(id)) inventory.push({ id, name: `已删除账号 #${id}`, identity: null, stable: false, deleted: true });
  for (const account of inventory) {
    const name = norm(account.name);
    const full = names.filter(p => p.full.length >= 2 && name.includes(p.full)).map(p => p.provider);
    const candidates = full.length ? full : names.filter(p => p.aliases.some(alias => name.includes(alias))).map(p => p.provider);
    const targets = (keyTargets.get(account.identity) || []).filter(t => candidates.some(p => p.id === t.provider.id));
    const usage = usageByAccount.get(account.id) || [];
    const main = total(usage, 'amount');
    const mapping = { id: account.id, name: account.name, status: account.status, deleted: account.deleted,
      candidates: candidates.map(p => ({ id: p.id, name: p.name })), main, requests: total(usage, 'requests'),
      localGroups: usage.map(row => ({ id: row.group_id || 'unknown', name: row.group_name || `分组 #${row.group_id || '未知'}`,
        main: total([row], 'amount'), requests: Number(row.requests) })),
      matched: false, method: full.length ? '完整名称' : '简称包含' };
    if (candidates.length === 1) Object.assign(mapping, { providerId: candidates[0].id, providerName: candidates[0].name });
    if (!account.stable) mapping.reason = '当日账号身份发生变化或缺少有效历史依据';
    else if (!candidates.length) mapping.reason = '名称未匹配供应商';
    else if (!targets.length) mapping.reason = candidates.length > 1 ? '供应商候选不唯一，Key 未能核验' : '完整 Key 未匹配';
    else if (targets.length > 1) mapping.reason = 'Key 对应多个供应商或当日上游分组';
    else {
      const target = targets[0];
      Object.assign(mapping, { matched: true, providerId: target.provider.id, providerName: target.provider.name,
        groupId: target.group.id, groupName: target.group.name, keyId: target.key.id, maskedKey: target.key.maskedKey,
        reason: '名称与完整 Key 指纹交叉核验唯一' });
      target.key.accounts.push(mapping);
    }
    if (!mapping.matched) {
      const possible = keyTargets.get(account.identity) || [];
      for (const target of possible) target.key.blocked = true;
      if (!possible.length && usage.length) for (const group of groups.values()) {
        if (candidates.some(p => p.id === group.providerId)) group.mappingBlocked = true;
      }
    }
    mappings.push(mapping);
  }
  for (const group of groups.values()) {
    for (const key of group.keys) { key.main = source.complete ? total(key.accounts, 'main') : null; key.requests = total(key.accounts, 'requests'); }
    const accounts = group.keys.flatMap(k => k.accounts);
    group.accountCount = unique(accounts.map(a => a.id)).length;
    group.localGroupCount = unique(accounts.flatMap(a => a.localGroups.map(g => g.id))).length;
    group.upstreamComplete = group.keys.every(k => k.upstreamComplete);
    group.upstream = group.upstreamComplete ? total(group.keys, 'upstream') : null;
    group.knownUpstream = total(group.keys.filter(k => k.upstream !== null), 'upstream');
    group.main = source.complete ? total(accounts, 'main') : null;
    group.requests = total(accounts, 'requests');
    group.comparable = source.complete && group.upstreamComplete && !group.mappingBlocked && group.keys.every(k => k.accounts.length > 0 && !k.blocked);
    if (group.mappingBlocked || group.keys.some(k => k.blocked)) group.reasons.push('存在可能属于该分组的待核对账号，主站金额仅为已关联小计');
    group.diff = group.comparable ? new Decimal(group.main).minus(group.upstream).toDecimalPlaces(8).toNumber() : null;
    group.rate = group.diff !== null && group.main > 0 ? new Decimal(group.diff).div(group.main).times(100).toDecimalPlaces(4).toNumber() : null;
  }
  const missingProviders = upstream.items.filter(p => !p.keys.length).map(p => ({ id: p.id, name: p.name, reasons: p.reasons }));
  return { date, computedAt: at, siteComplete: source.complete, groups: [...groups.values()], mappings, missingProviders };
}
module.exports = { buildGroupReport, total, groupId, aliases };
