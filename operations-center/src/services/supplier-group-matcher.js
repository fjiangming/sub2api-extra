'use strict';
const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const total = (items, field) => items.reduce((sum, item) => sum.plus(item[field] ?? 0), new Decimal(0)).toDecimalPlaces(8).toNumber();
const unique = values => [...new Set(values)];
const uniqueAccounts = accounts => {
  const seen = new Set();
  return accounts.filter(account => {
    const id = String(account.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};
const groupId = (provider, group) => crypto.createHash('sha256').update(JSON.stringify([provider, group])).digest('hex').slice(0, 32);

function sameValue(left, right) {
  return left === right || (left !== null && right !== null && Number.isFinite(Number(left)) &&
    Number.isFinite(Number(right)) && new Decimal(left).eq(right));
}

function canonicalizeKeys(keys) {
  const seen = new Map(), result = [];
  for (const key of keys) {
    // A provider can expose the same secret more than once in one upstream
    // group. Identical usage rows describe one key and must be counted once;
    // conflicting rows remain separate so the report stays non-comparable.
    const signature = key.identity && key.groupRef !== null ? `${key.identity}\0${key.groupRef}` : null;
    const previous = signature ? seen.get(signature) : null;
    if (!previous) {
      const copy = { ...key };
      if (signature) seen.set(signature, copy);
      result.push(copy);
      continue;
    }
    const identical = sameValue(previous.cost, key.cost) && sameValue(previous.upstreamAmount, key.upstreamAmount) &&
      sameValue(previous.requests, key.requests);
    if (!identical) {
      result.push({ ...key });
      continue;
    }
    previous.duplicateKeyCount = (previous.duplicateKeyCount || 1) + 1;
    previous.reasons = unique([...(previous.reasons || []), '同一上游 Key 在同一分组重复返回，已合并一次']);
  }
  return result;
}

function canonicalizeUpstream(upstream) {
  return { ...upstream, items: upstream.items.map(provider => ({ ...provider, keys: canonicalizeKeys(provider.keys) })) };
}

function aliases(provider, settings) {
  const stem = norm(String(provider.name).replace(/\s*api\s*$/i, ''));
  const configured = Object.hasOwn(settings.aliases, provider.id) ? settings.aliases[provider.id] : [];
  return unique([...configured, stem].map(norm).filter(v =>
    v.length >= 2 && !['api', 'https', 'http', 'com', 'cn', 'vip', 'relay', 'cloud', 'provider', '供应商'].includes(v)));
}
function buildGroupReport(upstream, source, settings, date, at) {
  const normalized = canonicalizeUpstream(upstream);
  const names = normalized.items.map(provider => ({ provider, full: norm(provider.name), aliases: aliases(provider, settings) }));
  const groups = new Map(), keyTargets = new Map();
  for (const provider of normalized.items) for (const key of provider.keys) {
    const item = { id: key.id, name: key.name, maskedKey: key.maskedKey, upstream: key.cost,
      upstreamComplete: key.complete === true && provider.accountCovered === true && !provider.stale && !provider.archiveConflict,
      accounts: [], blocked: false, reasons: key.reasons || [],
      ...(key.duplicateKeyCount > 1 ? { duplicateKeyCount: key.duplicateKeyCount } : {}) };
    let group = null;
    if (key.groupRef !== null) {
      const id = groupId(provider.id, key.groupRef);
      if (!groups.has(id)) groups.set(id, { id, providerId: provider.id, providerName: provider.name,
        groupRef: key.groupRef, name: key.groupName || key.groupRef, keys: [],
        archiveConflict: provider.archiveConflict === true, stale: provider.stale === true, reasons: [...(provider.reasons || [])] });
      group = groups.get(id); group.keys.push(item);
    }
    if (key.identity) {
      if (!keyTargets.has(key.identity)) keyTargets.set(key.identity, []);
      keyTargets.get(key.identity).push({ provider, group, key: item });
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
      matched: false, historyVerified: account.stable === true, method: full.length ? '完整名称' : '简称包含' };
    if (candidates.length === 1) Object.assign(mapping, { providerId: candidates[0].id, providerName: candidates[0].name });
    if (!candidates.length) mapping.reason = '名称未匹配供应商';
    else if (!targets.length) mapping.reason = candidates.length > 1 ? '供应商候选不唯一，Key 未能核验' : '完整 Key 未匹配';
    else if (targets.length > 1) mapping.reason = 'Key 对应多个供应商或当日上游分组';
    else if (!targets[0].group) mapping.reason = targets[0].key.upstream === 0
      ? 'Key 已核验零消费，历史上游分组未观察' : 'Key 已核验，历史上游分组未定位';
    else {
      const target = targets[0];
      Object.assign(mapping, { matched: true, providerId: target.provider.id, providerName: target.provider.name,
        groupId: target.group.id, groupName: target.group.name, keyId: target.key.id, maskedKey: target.key.maskedKey,
        reason: account.stable ? '名称与完整 Key 指纹交叉核验唯一'
          : '当前分组已唯一定位；当日账号身份发生变化或缺少有效历史依据，全天消费归属待核对' });
      target.key.accounts.push(mapping);
      if (!account.stable) {
        target.key.blocked = true;
        target.group.reasons.push('已展示当前关联账号的全天消费；账号身份历史未核验，差额暂不核定');
        if (usage.length) for (const group of groups.values()) {
          if (candidates.some(p => p.id === group.providerId)) group.mappingBlocked = true;
        }
      }
    }
    if (!mapping.matched) {
      const possible = keyTargets.get(account.identity) || [];
      for (const target of possible) target.key.blocked = true;
      if ((!possible.length || possible.some(t => !t.group)) && usage.length) for (const group of groups.values()) {
        if (candidates.some(p => p.id === group.providerId)) group.mappingBlocked = true;
      }
    }
    mappings.push(mapping);
  }
  for (const group of groups.values()) {
    for (const key of group.keys) {
      key.accounts = uniqueAccounts(key.accounts);
      key.accountCount = key.accounts.length;
      if (key.accountCount > 1) {
        key.sharedAccountCount = key.accountCount;
        for (const account of key.accounts) account.sharedKeyAccountCount = Math.max(account.sharedKeyAccountCount || 0, key.accountCount);
      }
      key.main = source.complete ? total(key.accounts, 'main') : null;
      key.requests = total(key.accounts, 'requests');
    }
    const accounts = uniqueAccounts(group.keys.flatMap(k => k.accounts));
    group.accountCount = accounts.length;
    group.sharedKeyCount = group.keys.filter(key => key.accountCount > 1).length;
    group.sharedAccountCount = uniqueAccounts(group.keys.filter(key => key.accountCount > 1).flatMap(key => key.accounts)).length;
    group.duplicateKeyCount = group.keys.reduce((sum, key) => sum + Math.max(0, (key.duplicateKeyCount || 1) - 1), 0);
    group.localGroupCount = unique(accounts.flatMap(a => a.localGroups.map(g => g.id))).length;
    group.upstreamComplete = group.keys.every(k => k.upstreamComplete);
    group.upstream = group.upstreamComplete ? total(group.keys, 'upstream') : null;
    group.knownUpstream = total(group.keys.filter(k => k.upstream !== null), 'upstream');
    group.main = source.complete ? total(accounts, 'main') : null;
    group.requests = total(accounts, 'requests');
    group.comparable = source.complete && group.upstreamComplete && !group.mappingBlocked && group.keys.every(k => k.accounts.length > 0 && !k.blocked);
    if (group.mappingBlocked || group.keys.some(k => k.blocked)) group.reasons.push('存在可能属于该分组的待核对账号，主站金额仅为已关联小计');
    group.reasons = unique(group.reasons);
    group.diff = group.comparable ? new Decimal(group.main).minus(group.upstream).toDecimalPlaces(8).toNumber() : null;
    group.rate = group.diff !== null && group.main > 0 ? new Decimal(group.diff).div(group.main).times(100).toDecimalPlaces(4).toNumber() : null;
  }
  const missingProviders = normalized.items.filter(p => !p.keys.length).map(p => ({ id: p.id, name: p.name, reasons: p.reasons }));
  return { date, computedAt: at, siteComplete: source.complete, groups: [...groups.values()], mappings, missingProviders };
}
module.exports = { buildGroupReport, total, groupId, aliases, canonicalizeKeys, canonicalizeUpstream };
